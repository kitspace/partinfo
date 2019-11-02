const immutable = require('immutable')
const rateLimit = require('promise-rate-limit')
const superagent = require('superagent')
const redis = require('redis')

const {getRetailers, getCurrencies} = require('./queries')

const currency_cookies = immutable.Map({
  USD:
    'currency=eyJpdiI6InJOVjRyS3JCdXphUkVnTk1KSTZGb3c9PSIsInZhbHVlIjoiaGluMUZSQ1JBXC9EU1Qxd2dsMTJsNDhxaUZGXC9tUjNzU0V4RDNZN0tDdmZSRDdZdXB0R3ZhVm1XVnlHRFJVZGxvRE1uOEpiUCtrcUNDeG94VTlGcUU4Z1ZUVFAyWGgxUzdvRXRBVWF3am9oNjVkTEhGbFdrbjFNR3pmTGltOGRBS0dFTWdVdm56V2ZYWmdMYkhBQTFKN3c9PSIsIm1hYyI6IjVjZjZkZDExZWNlMmRkOGQ4Y2FlNWI5ZjUyNmEyYTAzZjJlNWQ5MTg5M2EzNjg2OWRhZWMyM2VhZDlhN2NmM2YifQ==',
  EUR:
    'currency=eyJpdiI6Im9rZzRtNUZJOGRQdjVCWmNpQzBMQ3c9PSIsInZhbHVlIjoiU0dzd2dZTW02c0dQYXBIWEtWQVVQRGp3cno3S2JHSTN5c1E0YTFlM3VZZmo1WmJzOHdRSFpMYmt3b1UwOTNXY0xVMWFEREUwQXI1MWs4dWNVNFY5ekZ6MHZteUF1ZzhIVnBleWVZK0oxd0hXOTBhbFpFQUhOYWFuTDJiTDV6c0Z0cDZ0OVduYWpPOEZHdkhiY1BZUW93PT0iLCJtYWMiOiI2Mjk0N2M1MmYyMjdmNTg0Mjk1NzlmMjU2MzUxYjM0MzcwYTNkMTM4MzIwNGE5OWNiMDYxOTAzMTlmMjIwNjg2In0=',
  GBP:
    'currency=eyJpdiI6ImVHalVzZUJDaTFiQXg4ZjhVMGQzRVE9PSIsInZhbHVlIjoiNWdEZnFBTlgzb0t2bHA5WlRIRzh1U0I1WlwvU1RlK0R1ZE9ZdGhLXC9RODlhdFVTUWJJMG1CSXdGS01SRzRJTGxtV01YbFwvZFZQbjFkUVVZd09HUXNTUnRraWc0UFZ6UVFhekhPZFVYMWU1UlVSZ2xLOTc3UHV0MERWNnJnQ1VkbHozcldxUWJYV3R4bjVzVkYrcjVySkN3PT0iLCJtYWMiOiI3MzRhMGQwN2VkODEzMTk0YTEwMDQ0ZmNjZGI0MmJlMzQxMzA0Zjk2MzQ0MjBmMGQ4MTdiOWMzMDg5MTgyNDQ2In0=',
  SGD:
    'currency=eyJpdiI6InQ3cnVJXC83Z1JYbzFPS214dTZDXC9NQT09IiwidmFsdWUiOiJvczFRNWt5dFBneDFKRzlPZ3ljUENYTnlnNndnUHd2Z1wvMDQ3SUdpcE9OYUI2TDN0dEE3K0dGUWpcL1pBUFdZSE9RM05EWlNzV3l1TXVBOEpmZFRZT3Z6MG54amE5YVJsS1BhMHV0V2s5NjZlUVFQS3dEbmE4dVJiNHpGaVh1Sk1oU2NnVlluSEZqK3hHa0J3Rlp6Z0VPQT09IiwibWFjIjoiMzI5ZDJlMjJkMDUzOTJiMzg3YzUxZThkNmY2OTMxNjQzZTdlOTdlNzEwNDBmOTYyMDdkZTZjODRmNGI0Nzc0YiJ9',
})

const supported_currencies = currency_cookies.keySeq()

const runQuery = rateLimit(30, 1000, async function(term, currency) {
  const url = 'https://lcsc.com/api/global/search'
  return superagent
    .post(url)
    .type('form')
    .query('q=' + term)
    .send({page: 1, order: ''})
    .accept('application/json')
    .set('cookie', currency_cookies.get(currency))
    .then(r => {
      if (r.status !== 200) {
        console.error(r.status)
      }
      return immutable.fromJS(r.body.result.transData)
    })
})

async function searchAcrossCurrencies(query, currencies) {
  if (currencies.length === 0) {
    currencies = immutable.Seq.of('USD')
  }
  const responses = await Promise.all(
    currencies.map(c => runQuery(query, c))
  ).then(rs => immutable.List(rs).flatten(1))
  return responses
    .reduce((merged, result) => {
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
      const mpn = result.get('mpn')
      const sku = result.get('sku')
      const prices = result.get('prices')
      result = immutable.fromJS({
        mpn,
        offers: [{sku, prices}],
      })
      const existing = merged.findIndex(r => r.get('mpn').equals(mpn))
      if (existing >= 0) {
        merged = merged.updateIn([existing, 'offers', 'prices'], p =>
          p.concat(prices)
        )
      } else {
        merged = merged.push(result)
      }
      return merged
    }, immutable.List())
}

function processResult(result) {
  const mpn = getMpn(result)
  const sku = getSku(result)
  const prices = getPrices(result)
  return immutable.fromJS({mpn, sku, prices})
}

const symbol_to_currency = immutable.Map({
  US$: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  S$: 'SGD',
})

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
  return immutable.Map({
    part: result
      .getIn(['info', 'number'])
      .replace(/<.*?>/g, '')
      .trim(),
    manufacturer: result.getIn(['manufacturer', 'en']),
  })
}

function lcsc(queries) {
  return Promise.all(
    queries.map(async q => {
      const currencies = getCurrencies(q)
      const retailers = getRetailers(q)
      const term = q.get('term')
      const mpn = q.get('mpn')
      const sku = q.get('sku')
      const is_lcsc_sku = sku != null && sku.get('vendor') === 'LCSC'
      if (!retailers.includes('LCSC') && !is_lcsc_sku) {
        return [q, null]
      }
      let response
      if (term != null) {
        response = await searchAcrossCurrencies(term, currencies)
      } else if (mpn != null) {
        const s = (mpn.get('manufacturer') + ' ' + mpn.get('part')).trim()
        response = await searchAcrossCurrencies(s, currencies)
        console.log(JSON.stringify(response, null, 2))
      } else if (is_lcsc_sku) {
        response = await searchAcrossCurrencies(sku.get('part'), currencies)
      }
      return [q, response]
    })
  ).then(immutable.Map)
}

module.exports = lcsc
