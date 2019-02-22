const immutable = require('immutable')

const octopart = require('./octopart')
const {ELEMENT14_API_KEYS} = require('../config')

if (!ELEMENT14_API_KEYS[0]) {
  console.warn('Not using element14 API')
}

const retailers =
  ELEMENT14_API_KEYS[0]
    ? immutable.Map()
    : immutable.Map({
        Farnell: require('./farnell'),
        // disabled for now until we can optimize
        //Newark: require('./newark'),
      })

function runRetailers(results) {
  return Promise.all(
    results
      .map((result, query) => {
        let promise
        if (immutable.List.isList(result)) {
          promise = Promise.all(result.map(part => run(query, part))).then(
            immutable.List
          )
        } else {
          promise = run(query, result)
        }
        return promise.then(r => {
          return [query, r]
        })
      })
      .toArray()
  ).then(immutable.Map)
}

function run(query, part) {
  let offers = part.get('offers') || immutable.List()
  const query_sku = query.get('sku')
  if (
    query_sku &&
    retailers.has(query_sku.get('vendor')) &&
    !offers.some(offer => offer.get('sku').equals(query_sku))
  ) {
    offers = offers.push(immutable.Map({sku: query_sku}))
  }
  // get all the offers that are not going to be updated by querying retailer
  // specific APIs
  const not_yet_offers = offers.filter(offer => {
    const vendor = offer.getIn(['sku', 'vendor'])
    return !retailers.has(vendor)
  })
  return Promise.all(
    Object.keys(retailers).map(name => {
      const this_offers = offers.filter(
        offer => offer.getIn(['sku', 'vendor']) === name
      )
      return runOffers(name, this_offers)
    })
  ).then(newOffers => {
    newOffers = immutable.List(newOffers).flatten(1)
    if (!part.get('mpn')) {
      // if octopart didn't find it the first time then get an mpn from the
      // retailers and try that
      const with_mpn = newOffers.find(x => x.get('mpn'))
      if (with_mpn) {
        const mpn = with_mpn.get('mpn')
        const query = immutable.Map({mpn})
        return octopart(immutable.List.of(query)).then(r => {
          const octopart_part = r.get(query)
          if (octopart_part) {
            return octopart_part.update('offers', o => o.concat(newOffers))
          }
          return part
            .set('offers', newOffers.concat(not_yet_offers))
            .set('mpn', mpn)
        })
      }
      return part.set('offers', newOffers.concat(not_yet_offers))
    }
    return part.set('offers', newOffers.concat(not_yet_offers))
  })
}

function runOffers(name, offers) {
  return Promise.all(
    offers.map(offer =>
      retailers[name](offer.getIn(['sku', 'part'])).then(o =>
        offer.mergeDeep(o)
      )
    )
  )
    .then(offers => offers.filter(o => o.get('no_longer_stocked') !== true))
    .then(immutable.List)
}

module.exports = runRetailers
