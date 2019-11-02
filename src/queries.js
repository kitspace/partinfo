const immutable = require('immutable')
const retailer_map = immutable.OrderedMap({
  'Digi-Key': 'Digikey',
  Mouser: 'Mouser',
  'RS Components': 'RS',
  Newark: 'Newark',
  'element14 APAC': 'Farnell',
  Farnell: 'Farnell',
})

const retailer_reverse_map = retailer_map.mapEntries(([k, v]) => [v, k])
const default_retailers = immutable.Set.fromKeys(retailer_reverse_map)

function getRetailers(query) {
  return (
    query.getIn([
      'fields',
      'offers',
      '__arguments',
      0, //XXX needs to be udpated if more arguments are added
      'from',
      'value',
    ]) || default_retailers
  )
}

function getCurrencies(query) {
  const prices = query.getIn(['fields', 'offers', 'prices'])
  if (prices == null) {
    return immutable.Seq()
  }
  return prices.keySeq()
}

module.exports = {
  retailer_map,
  retailer_reverse_map,
  default_retailers,
  getRetailers,
  getCurrencies,
}
