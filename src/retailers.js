const immutable = require('immutable')

const retailers = {
  Farnell: require('./farnell'),
  //disabled for now until we can optimize
  //Newark: require('./newark'),
}

const not_yet = immutable.List.of('Digikey', 'Mouser', 'RS')

function runRetailers(results) {
  return Promise.all(
    results
      .map((result, query) => {
        const query_sku = query.get('sku')
        if (query_sku) {
          const offers = result.get('offers') || immutable.List()
          const contains_sku = offers.some(offer =>
            offer.get('sku').equals(query_sku)
          )
          if (!contains_sku) {
            result = result.set(
              'offers',
              offers.push(immutable.Map({sku: query_sku}))
            )
          }
        }
        let promise
        if (immutable.List.isList(result)) {
          promise = Promise.all(result.map(run)).then(immutable.List)
        } else {
          promise = run(result)
        }
        return promise.then(r => {
          return [query, r]
        })
      })
      .toArray()
  ).then(immutable.Map)
}

function run(part) {
  const offers = part.get('offers') || immutable.List()
  const not_yet_offers = offers.filter(offer => {
    const vendor = offer.getIn(['sku', 'vendor'])
    return not_yet.includes(vendor)
  })
  return Promise.all(
    Object.keys(retailers).map(name => {
      const this_offers = offers.filter(
        offer => offer.getIn(['sku', 'vendor']) === name
      )
      return runRetailer(name, this_offers)
    })
  ).then(newOffers => {
    newOffers = immutable.List(newOffers).flatten(1)
    if (!part.get('mpn')) {
      const withMpn = newOffers.find(x => x.get('mpn'))
      if (withMpn) {
        part = part.set('mpn', withMpn.get('mpn'))
      }
    }
    return part.set('offers', newOffers.concat(not_yet_offers))
  })
}

function runRetailer(name, offers) {
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
