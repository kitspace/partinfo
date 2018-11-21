const immutable = require('immutable')
const url = require('url')
const superagent = require('superagent')
const {ELEMENT14_API_KEY} = require('../config')

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
  const url = `https://api.element14.com/catalog/products?callInfo.responseDataFormat=json&term=id%3A${sku}&storeInfo.id=${site}&callInfo.apiKey=${ELEMENT14_API_KEY}&resultsSettings.responseGroup=inventory`
  return superagent
    .get(url)
    .set('accept', 'application/json')
    .then(r => {
      const p = r.body.premierFarnellPartNumberReturn.products[0]
      return immutable.fromJS({
        in_stock_quantity: p.stock.level,
        stock_location:
          p.nationalClassCode === 'F' ? extendedLocation : location,
      })
    })
    .catch(e => {
      console.error(e)
      return immutable.Map()
    })
}

module.exports = element14
