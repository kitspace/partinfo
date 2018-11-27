const immutable = require('immutable')
const url = require('url')
const superagent = require('superagent')
const rateLimit = require('promise-rate-limit')
const {ELEMENT14_API_KEYS} = require('../config')

let key_select = 0

function element14(name, sku) {
  let site, currency, location, extendedLocation
  if (name === 'Newark') {
    site = 'www.newark.com'
    currency = 'USD'
    location = 'US'
    extendedLocation = 'UK'
  } else if (name === 'Farnell') {
    site = 'uk.farnell.com'
    currency = 'GBP'
    location = 'UK'
    extendedLocation = 'US'
  } else {
    throw Error(`Only Newark and Farnell supported, got ${name}`)
  }
  const api_key = ELEMENT14_API_KEYS[key_select]
  key_select = (key_select + 1) % ELEMENT14_API_KEYS.length
  const url = `https://api.element14.com/catalog/products?callInfo.responseDataFormat=json&term=id%3A${sku}&storeInfo.id=${site}&callInfo.apiKey=${api_key}&resultsSettings.responseGroup=inventory`
  return superagent
    .get(url)
    .set('accept', 'application/json')
    .then(r => {
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
        try {
          const x = JSON.parse(e.response.text)
          if (x.Fault.Detail.searchException.exceptionCode === '200003') {
            return immutable.Map({
              no_longer_stocked: true,
            })
          } else {
            console.error(e)
          }
        } catch (e2) {
          console.error(e)
        }
      } else {
        console.error(e)
      }
      return immutable.Map()
    })
}

module.exports = rateLimit(2, 1000, element14)
