const immutable = require('immutable')
const url = require('url')
const superagent = require('superagent')
const rateLimit = require('promise-rate-limit')
const redis = require('redis')
const {ELEMENT14_API_KEYS, ELEMENT14_CACHE_TIMEOUT_S} = require('../config')

const redisClient = redis.createClient()

let key_select = 0

const runQuery = rateLimit(1, 1000, function(sku, site) {
  const api_key = ELEMENT14_API_KEYS[key_select]
  key_select = (key_select + 1) % ELEMENT14_API_KEYS.length

  let location, extendedLocation
  if (site === 'uk.farnell.com') {
    location = 'UK'
    extendedLocation = 'US'
  } else if (site === 'www.newark.com') {
    location = 'US'
    extendedLocation = 'UK'
  } else {
    throw Error(`Only Newark and Farnell supported, got ${site}`)
  }

  const url = `https://api.element14.com/catalog/products?callInfo.responseDataFormat=json&term=id%3A${sku}&storeInfo.id=${site}&callInfo.apiKey=${api_key}&resultsSettings.responseGroup=inventory`
  return superagent
    .get(url)
    .set('accept', 'application/json')
    .then(r => {
      const products = r.body.premierFarnellPartNumberReturn.products
      if (products == null || products.length == 0) {
	      return immutable.Map()
      }
      const p = r.body.premierFarnellPartNumberReturn.products[0]
      const mpn = {
        manufacturer: p.brandName,
        part: p.translatedManufacturerPartNumber,
      }
      return immutable.fromJS({
        mpn,
        in_stock_quantity: p.stock.level,
        stock_location:
          p.nationalClassCode === 'F' ? extendedLocation : location,
      })
    })
    .catch(e => {
      if (e && e.response && e.response.text) {
        const x = JSON.parse(e.response.text)
        if (
          x &&
          x.Fault &&
          x.Fault.Detail &&
          x.Fault.Detail.searchException &&
          x.Fault.Detail.searchException.exceptionCode === '200003'
        ) {
          return immutable.Map({
            no_longer_stocked: true,
          })
        }
      }
      throw e
    })
    .then(r => {
      if (r == null) {
        r = {}
      }
      const redisKey = queryToKey({sku, site})
      redisClient.set(
        redisKey,
        JSON.stringify(r),
        'EX',
        ELEMENT14_CACHE_TIMEOUT_S
      )
      return r
    })
})

async function element14(name, sku) {
  let site
  if (name === 'Newark') {
    site = 'www.newark.com'
  } else if (name === 'Farnell') {
    site = 'uk.farnell.com'
  } else {
    throw Error(`Only Newark and Farnell supported, got ${name}`)
  }
  const cached = await new Promise((resolve, reject) => {
    const redisKey = queryToKey({sku, site})
    redisClient.get(redisKey, (err, response) => {
      if (err) {
        console.error(err)
      }
      resolve(response)
    })
  })
  if (cached != null) {
    return immutable.fromJS(JSON.parse(cached))
  }
  return runQuery(sku, site)
}

function queryToKey(query) {
  return 'element14:' + query.site + '/' + query.sku
}

module.exports = element14
