const immutable = require('immutable')
const rateLimit = require('promise-rate-limit')
const superagent = require('superagent')
const cheerio = require('cheerio')
const Redis = require('ioredis')

const {LCSC_CACHE_TIMEOUT_S} = require('../config')

const redis = new Redis()

const {getRetailers, getCurrencies} = require('./queries')
const jlc_assembly_map = require('./jlc_assembly.json')
const {
  currency_cookies,
  symbol_to_currency,
  manufacturer_map,
  capacitance_map,
  capacitor_tolerance_map,
  capacitor_characteristic_map,
  capacitor_voltage_rating_map,
  resistance_map,
  resistor_power_map,
  resistor_tolerance_map,
  led_color_map,
  spec_map,
} = require('./lcsc_data')

const _search = rateLimit(80, 120000, async function(term, currency, params) {
  let url, params_string
  if (params == null) {
    url = 'https://lcsc.com/api/global/search'
    params_string = `q=${encodeURIComponent(term)}&page=1&order=`
  } else {
    url = 'https://lcsc.com/api/products/search'
    params.search_content = term
    params_string = ''
    for (const key in params) {
      if (immutable.Iterable.isIterable(params[key])) {
        params[key].forEach(x => (params_string += '&' + key + '=' + x))
      } else if (params[key] != null) {
        params_string += '&' + key + '=' + params[key]
      }
    }
  }
  return superagent
    .post(url)
    .type('form')
    .query(params_string)
    .accept('application/json')
    .set('cookie', currency_cookies.get(currency))
    .then(r => {
      console.info('x-ratelimit-remaining', r.header['x-ratelimit-remaining'])
      if (r.status !== 200) {
        console.error('LCSC network error:', r.status)
      }
      if (r.body == null || r.body.result == null) {
        console.error('LCSC no result')
        return immutable.List()
      }
      return immutable.fromJS(r.body.result.transData || r.body.result.data)
    })
})

function toKey(...args) {
  return 'lcsc:' + immutable.fromJS(args).hashCode()
}

async function search(term, currency, params) {
  const key = toKey(term, currency, params)
  const cached = await redis.get(key)
  if (cached != null) {
    return immutable.fromJS(JSON.parse(cached))
  }
  return _search(term, currency, params).then(async r => {
    if (r != null) {
      await redis.set(key, JSON.stringify(r), 'EX', LCSC_CACHE_TIMEOUT_S)
    }
    return r
  })
}

const _skuMatch = rateLimit(80, 120000, async function(sku, currencies) {
  const url = 'https://lcsc.com/pre_search/link?type=lcsc&&value=' + sku
  return superagent
    .get(url)
    .then(r => {
      const $ = cheerio.load(r.text)
      const part = $('.detail-mpn-title').text()
      if (!part) {
        return null
      }
      return searchAcrossCurrencies(part, currencies)
    })
    .then(parts => {
      return immutable.List.of(
        parts &&
          parts.find(part => {
            const offer = part
              .get('offers')
              .find(o => o.getIn(['sku', 'part']) === sku)
            return offer != null
          })
      ).filter(x => x)
    })
})

async function skuMatch(sku, currencies) {
  const key = toKey(sku, currencies)
  const cached = await redis.get(key)
  if (cached != null) {
    return immutable.fromJS(JSON.parse(cached))
  }
  return _skuMatch(sku, currencies).then(async r => {
    if (r != null) {
      await redis.set(key, JSON.stringify(r), 'EX', LCSC_CACHE_TIMEOUT_S)
    }
    return r
  })
}

async function searchAcrossCurrencies(term, currencies, params) {
  if (currencies == null || currencies.size === 0) {
    currencies = immutable.List.of('USD')
  }
  let responses = await Promise.all(
    currencies.map(c => search(term, c, params))
  ).then(rs => immutable.List(rs).flatten(1))
  responses = responses
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
      const offers = immutable.List.of(
        result
          .remove('mpn')
          .remove('datasheet')
          .remove('specs')
      )
      const existing = merged.findIndex(r => r.get('mpn').equals(mpn))
      if (existing >= 0) {
        merged = merged.updateIn([existing, 'offers'], os => os.concat(offers))
      } else {
        const datasheet = result.get('datasheet')
        const description = result.get('description')
        const image = result.get('image')
        const specs = result.get('specs')
        merged = merged.push(
          immutable.Map({mpn, datasheet, image, specs, description, offers})
        )
      }
      return merged
    }, immutable.List())
  return Promise.all(
    responses.map(async part => {
      let offers = part.get('offers')
      offers = await Promise.all(
        offers.map(async offer => {
          if (offer.get('jlc_assembly') != null) {
            const sku = offer.getIn(['sku', 'part'])
            const jlc_offer = (await _searchJlcAssembly(sku))[0] || {}
            if (jlc_offer.componentCode === sku) {
              offer = offer.set('jlc_stock_quantity', jlc_offer.stockCount)
            }
          }
          return offer
        })
      )
      return part.set('offers', offers)
    })
  ).then(immutable.List)
}

function processResult(result) {
  const mpn = getMpn(result)
  const datasheet = result.getIn(['datasheet', 'pdf'])
  const sku = getSku(result)
  const jlc_assembly = jlc_assembly_map[sku.get('part')]
  const prices = getPrices(result)
  const description = result
    .get('description')
    .replace(/<.*?>/g, '')
    .trim()
  const in_stock_quantity = result.get('stock')
  const moq = result.getIn(['info', 'min'])
  const order_multiple = result.getIn(['info', 'step'])
  const product_url = 'https://lcsc.com' + result.get('url')
  let image
  if (result.getIn(['images', 0, '96x96']) != null) {
    image = {
      url: result.getIn(['images', 0, '96x96']),
      credit_string: 'LCSC',
      credit_url: 'https://lcsc.com',
    }
  }
  const specs = []
  if (result.get('package') != null) {
    specs.push({
      key: 'case_package',
      name: 'Case/Package',
      value: result
        .get('package')
        .replace(/<.*?>/g, '')
        .trim(),
    })
  }
  if (result.get('attributes') != null) {
    result.get('attributes').forEach((v, k) => {
      if (spec_map.get(k) != null) {
        specs.push(spec_map.get(k).set('value', v))
      }
    })
  }
  if (result.get('tags') && result.get('tags').includes('RoHS')) {
    specs.push({
      key: 'rohs_status',
      name: 'RoHS',
      value: 'Compliant',
    })
  }
  return immutable.fromJS({
    mpn,
    datasheet,
    image,
    specs,
    sku,
    prices,
    description,
    in_stock_quantity,
    moq,
    order_multiple,
    product_url,
    jlc_assembly,
  })
}

function getPrices(result) {
  const lcsc_prices = result.get('price')
  if (lcsc_prices == null) {
    return immutable.Map()
  }
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
  if (eg == null) {
    return
  }
  const type = eg.get('type')
  const size = eg.get('size')
  if (size == null) {
    return
  }
  const params = {
    'attributes[package][]': size,
    current_page: '1',
    in_stock: 'false',
    is_RoHS: 'true',
    show_icon: 'false',
  }

  if (eg.get('type') === 'resistor') {
    params.category = 439 // chip resistors
    const resistance = resistance_map.get(eg.get('resistance'))
    if (resistance == null) {
      return
    }

    const eg_tolerance = eg.get('tolerance')
    // select all below the maximum
    let lcsc_tolerance = resistor_tolerance_map
      .groupBy((_, k) => k <= eg_tolerance)
      .get(true)
    if (eg_tolerance != null && lcsc_tolerance == null) {
      return
    } else if (lcsc_tolerance != null) {
      lcsc_tolerance = lcsc_tolerance.valueSeq()
    }

    const eg_power_rating = eg.get('power_rating')
    // select all above the minimum
    let lcsc_power_rating = resistor_power_map
      .groupBy((_, k) => k >= eg_power_rating)
      .get(true)
    if (eg_power_rating != null && lcsc_power_rating == null) {
      return
    } else if (lcsc_power_rating != null) {
      lcsc_power_rating = lcsc_power_rating.valueSeq()
    }

    params['attributes[Resistance+(Ohms)][]'] = resistance
    params['attributes[Tolerance][]'] = lcsc_tolerance
    params['attributes[Power+(Watts)][]'] = lcsc_power_rating
    return params
  } else if (eg.get('type') === 'capacitor') {
    params.category = 313 // MLC capacitors
    const capacitance = capacitance_map.get(eg.get('capacitance'))
    if (capacitance == null) {
      return
    }

    const eg_tolerance = eg.get('tolerance')
    // select all below the maximum
    let lcsc_tolerance = capacitor_tolerance_map
      .groupBy((_, k) => k <= eg_tolerance)
      .get(true)
    if (eg_tolerance != null && lcsc_tolerance == null) {
      return
    } else if (lcsc_tolerance != null) {
      lcsc_tolerance = lcsc_tolerance.valueSeq()
    }

    const eg_characteristic = eg.get('characteristic')
    const lcsc_characteristic = capacitor_characteristic_map.get(
      eg_characteristic
    )
    if (eg_characteristic != null && lcsc_characteristic == null) {
      return
    }

    const eg_voltage_rating = eg.get('voltage_rating')
    let lcsc_voltage_rating = capacitor_voltage_rating_map
      .groupBy((_, k) => k >= eg_voltage_rating)
      .get(true)
    if (eg_voltage_rating != null && lcsc_voltage_rating == null) {
      return
    } else if (lcsc_voltage_rating != null) {
      lcsc_voltage_rating = lcsc_voltage_rating.valueSeq()
    }

    params['attributes[Capacitance][]'] = capacitance
    params['attributes[Tolerance][]'] = lcsc_tolerance
    params['attributes[Temperature+Coefficient][]'] = lcsc_characteristic
    params['attributes[Voltage+-+Rated][]'] = lcsc_voltage_rating
    return params
  } else if (eg.get('type') === 'led') {
    params.category = 528 // LEDs
    const color = led_color_map.get(eg.get('color'))
    if (color == null) {
      return
    }
    params['attributes[Color][]'] = color
    return params
  }
}

async function parametricSearch(q, currencies) {
  const params = paramsFromElectroGrammar(q)
  if (params == null) {
    return searchAcrossCurrencies(q.get('term'), currencies)
  }
  let results = await searchAcrossCurrencies(
    q.getIn(['electro_grammar', 'ignored']),
    currencies,
    params
  )
  if (results.size === 0 && q.getIn(['electro_grammar', 'ignored'])) {
    results = await searchAcrossCurrencies('', currencies, params)
  }
  return results
}

async function mpnMatch(mpn, currencies) {
  const part = mpn.get('part')
  const response = await searchAcrossCurrencies(part, currencies)
  return response.filter(r => r.getIn(['mpn', 'part']) === part)
}

const __searchJlcAssembly = rateLimit(80, 120000, keyword => {
  keyword = encodeURIComponent(keyword).replace('%20', '+')
  const url =
    'https://jlcpcb.com/shoppingCart/smtGood/selectSmtComponentList' +
    `?currentPage=1&pageSize=10&keyword=${keyword}&secondeSortName=&componentSpecification=&componentLibraryType=`
  return superagent.post(url).then(r => r.body.data.list)
})

async function _searchJlcAssembly(keyword) {
  const key = toKey('jlc_assembly-' + keyword)
  const cached = await redis.get(key)
  if (cached != null) {
    return JSON.parse(cached)
  }
  return __searchJlcAssembly(keyword).then(async r => {
    if (r != null) {
      await redis.set(key, JSON.stringify(r), 'EX', LCSC_CACHE_TIMEOUT_S)
    }
    return r
  })
}

async function searchJlcAssembly(q, currencies) {
  const keyword = q.get('term')
  const jlc = await _searchJlcAssembly(keyword)
  let results = Promise.all(
    jlc.map(({componentCode}) => skuMatch(componentCode, currencies))
  ).then(rs => immutable.List(rs).flatten(1))
  return results
}

function mergeResults(x, y) {
  return x.concat(y).reduce((merged, result) => {
    // merge the different offers for the same MPN
    const mpn = result.get('mpn')
    const offers = result.get('offers')
    const existing = merged.findIndex(r => r.get('mpn').equals(mpn))
    if (existing >= 0) {
      return merged
    }
    return merged.push(result)
  }, immutable.List())
}

function lcsc(queries) {
  return Promise.all(
    queries.map(async q => {
      const currencies = getCurrencies(q)
      const retailers = getRetailers(q)
      const term = q.get('term')
      const mpn = q.get('mpn')
      const sku = q.get('sku')
      const is_lcsc_sku =
        sku != null &&
        (sku.get('vendor') === 'LCSC' || sku.get('vendor') === 'JLC Assembly')
      if (sku != null && !is_lcsc_sku) {
        return [q, immutable.List()]
      }
      let response
      if (term != null) {
        response = await Promise.all([
          searchJlcAssembly(q, currencies),
          parametricSearch(q, currencies),
        ]).then(([jlc, lcsc]) => mergeResults(jlc, lcsc))
        response = response.map(r => r.set('type', 'search'))
      } else if (mpn != null) {
        response = await mpnMatch(mpn, currencies)
        response = response.map(r => r.set('type', 'match'))
      } else if (is_lcsc_sku) {
        response = await skuMatch(sku.get('part'), currencies)
        response = response.map(r => r.set('type', 'match'))
      }
      return [q, response]
    })
  ).then(immutable.Map)
}

module.exports = lcsc
