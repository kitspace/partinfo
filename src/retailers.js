const immutable = require('immutable')

const octopart = require('./octopart')

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
      return runOffers(name, this_offers)
    })
  ).then(newOffers => {
    newOffers = immutable.List(newOffers).flatten(1)
    if (!part.get('mpn')) {
      //if octopart didn't find it the first time then get an mpn from the
      //retailers and try that
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
