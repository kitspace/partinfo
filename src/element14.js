const immutable = require('immutable')
const url = require('url')
const fetch = require('isomorphic-fetch')
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
  console.log({url})
  return fetch(url)
    .then(r => r.json())
    .then(r => {
      const stockedOutsideOfCountry = r.premierFarnellPartNumberReturn.products.reduce(
        (prev, prod) => prev && prod.nationalClassCode === 'F',
        true
      )
      return immutable.fromJS({
        stock_location: stockedOutsideOfCountry ? extendedLocation : location,
      })
    })

}

module.exports = element14
