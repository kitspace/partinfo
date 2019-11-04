const immutable = require('immutable')
const rateLimit = require('promise-rate-limit')
const superagent = require('superagent')
const redis = require('redis')
const cheerio = require('cheerio')

const {getRetailers, getCurrencies} = require('./queries')

const {
  currency_cookies,
  symbol_to_currency,
  manufacturer_map,
  capacitance_map,
  capacitor_tolerance_map,
  capactitor_characteristic_map,
  capactitor_voltage_rating_map,
  resistance_map,
  resistor_power_map,
  resistor_tolerance_map,
} = require('./lcsc_data')

const search = rateLimit(80, 1000, async function(term, currency) {
  const url = 'https://lcsc.com/api/global/search'
  return superagent
    .post(url)
    .type('form')
    .query('q=' + term)
    .send({page: 1, order: ''})
    .accept('application/json')
    .set('cookie', currency_cookies.get(currency))
    .then(r => {
      console.info('x-ratelimit-remaining', r.header['x-ratelimit-remaining'])
      if (r.status !== 200) {
        console.error(r.status)
      }
      return immutable.fromJS(r.body.result.transData)
    })
})

const skuMatch = rateLimit(80, 1000, async function(sku, currencies) {
  const url = 'https://lcsc.com/pre_search/link?type=lcsc&&value=' + sku
  return superagent
    .get(url)
    .then(r => {
      const $ = cheerio.load(r.text)
      const part = $('.detail-mpn-title').text()
      const manufacturer = $('.detail-brand-title').text()
      return searchAcrossCurrencies(manufacturer + ' ' + part, currencies)
    })
    .then(parts =>
      immutable.List.of(
        parts.find(part => {
          const offer = part
            .get('offers')
            .find(o => o.getIn(['sku', 'part']) === sku)
          return offer != null
        })
      )
    )
})

async function searchAcrossCurrencies(query, currencies) {
  if (currencies == null || currencies.size === 0) {
    currencies = immutable.List.of('USD')
  }
  const responses = await Promise.all(
    currencies.map(c => search(query, c))
  ).then(rs => immutable.List(rs).flatten(1))
  return responses
    .reduce((merged, result) => {
      // merge the prices that are in different currencies
      result = processResult(result)
      const sku = result.get('sku')
      const existing = merged.findIndex(r => r.get('sku').equals(sku))
      if (existing >= 0) {
        const prices = result.get('prices')
        merged = merged.mergeIn([existing, 'prices'], prices)
      } else {
        merged = merged.push(result)
      }
      return merged
    }, immutable.List())
    .reduce((merged, result) => {
      // merge the different offers for the same MPN
      const mpn = result.get('mpn')
      const offers = immutable.List.of(result.remove('mpn').remove('datasheet'))
      const existing = merged.findIndex(r => r.get('mpn').equals(mpn))
      if (existing >= 0) {
        merged = merged.updateIn([existing, 'offers'], os => os.concat(offers))
      } else {
        const datasheet = result.get('datasheet')
        const description = result.get('description')
        merged = merged.push(
          immutable.Map({mpn, datasheet, description, offers})
        )
      }
      return merged
    }, immutable.List())
}

function processResult(result) {
  const mpn = getMpn(result)
  const datasheet = result.getIn(['datasheet', 'pdf'])
  const sku = getSku(result)
  const prices = getPrices(result)
  const description = result
    .get('description')
    .replace(/<.*?>/g, '')
    .trim()
  const in_stock_quantity = result.get('stock')
  const moq = result.getIn(['info', 'min'])
  const order_multiple = result.getIn(['info', 'step'])
  const product_url = 'https://lcsc.com' + result.get('url')
  return immutable.fromJS({
    mpn,
    datasheet,
    sku,
    prices,
    description,
    in_stock_quantity,
    moq,
    order_multiple,
    product_url,
  })
}

function getPrices(result) {
  const lcsc_prices = result.get('price')
  const currency = symbol_to_currency.get(lcsc_prices.getIn([0, 3]))
  const prices = lcsc_prices.map(p => immutable.List.of(p.get(0), p.get(2)))
  return immutable.Map([[currency, prices]])
}

function getSku(result) {
  return immutable.Map({
    vendor: 'LCSC',
    part: result.get('number'),
  })
}

function getMpn(result) {
  let manufacturer = result
    .getIn(['manufacturer', 'en'])
    .replace(/<.*?>/g, '')
    .trim()
  manufacturer = manufacturer_map.get(manufacturer) || manufacturer

  const part = result
    .getIn(['info', 'number'])
    .replace(/<.*?>/g, '')
    .trim()

  return immutable.Map({part, manufacturer})
}

function paramsFromElectroGrammar(q) {
  const eg = q.get('electro_grammar')
  const type = eg.get('type')
  const size = eg.get('size')
  const ignored = eg.get('ignored')
  const resistance = eg.get('resistance')
  const capacitance = eg.get('capacitance')
  const color = eg.get('color')

  const params = {
    'attributes[package][]': size,
    current_page: '1',
    in_stock: 'false',
    is_RoHS: 'false',
    show_icon: 'false',
    search_content: ignored,
  }
  if (resistance != null) {
    params.category = 439 // chip resistors
    params['attributes[Resistance+(Ohms)][]'] = resistance_map[resistance]
  } else if (capacitance != null) {
    params.category = 313 // MLC capacitors
    params['attributes[Capacitance][]'] = capacitance_map[capacitance]
  }
}

function parametricSearch(q, currencies) {
  const params = paramsFromElectroGrammar(q)
}

function lcsc(queries) {
  return Promise.all(
    queries.map(async q => {
      const empty = immutable.List()
      const currencies = getCurrencies(q)
      const retailers = getRetailers(q)
      const term = q.get('term')
      const mpn = q.get('mpn')
      const sku = q.get('sku')
      const is_lcsc_sku = sku != null && sku.get('vendor') === 'LCSC'
      if (!retailers.includes('LCSC') && !is_lcsc_sku) {
        return [q, empty]
      }
      let response
      if (term != null) {
        const size = q.getIn(['electro_grammar', 'size'])
        if (size == null) {
          response = await searchAcrossCurrencies(term, currencies)
        } else {
          response = await parametricSearch(q, currencies)
        }
      } else if (mpn != null) {
        const s = (mpn.get('manufacturer') + ' ' + mpn.get('part')).trim()
        response = await searchAcrossCurrencies(s, currencies)
      } else if (is_lcsc_sku) {
        response = await skuMatch(sku.get('part'), currencies)
      }
      return [q, response]
    })
  ).then(immutable.Map)
}

module.exports = lcsc
