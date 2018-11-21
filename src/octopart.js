const superagent = require('superagent')
const immutable = require('immutable')
const apikey = require('../config').OCTOPART_API_KEY

const retailer_map = immutable.OrderedMap({
  'Digi-Key': 'Digikey',
  Mouser: 'Mouser',
  'RS Components': 'RS',
  Newark: 'Newark',
  'element14 APAC': 'Farnell',
  Farnell: 'Farnell',
})

const retailer_reverse_map = retailer_map.mapEntries(([k, v]) => [v, k])
const retailers_used = immutable.Set.fromKeys(retailer_map)

function transform(queries) {
  return flatten(
    queries.map(q => {
      const ret = {limit: 1}
      if (q.get('mpn')) {
        ret.mpn = q.getIn(['mpn', 'part'])
        //octopart has some issue with the slash
        ret.brand = q.getIn(['mpn', 'manufacturer']).replace(' / ', ' ')
      } else if (q.get('sku')) {
        ret.sku = q.getIn(['sku', 'part'])
        ret.seller = retailer_reverse_map.get(q.getIn(['sku', 'vendor']))
      } else if (q.get('term')) {
        ret.q = q.get('term')
        ret.limit = 20
      }
      if (q.get('multi')) {
        const reference = String(q.hashCode())
        return transform(q.get('multi')).map(x => Object.assign(x, {reference}))
      }
      ret.reference = String(q.hashCode())
      return ret
    })
  )
}

function octopart(queries) {
  const octopart_queries = transform(queries)
  return superagent
    .get('https://octopart.com/api/v3/parts/match')
    .query(
      'include[]=specs&include[]=short_description&include[]=imagesets&include[]=datasheets'
    )
    .query({
      apikey,
      queries: JSON.stringify(octopart_queries),
    })
    .set('Accept', 'application/json')
    .then(res => {
      if (res.status !== 200) {
        console.error(res.status, queries)
      }
      const results = res.body.results
      return queries.reduce((returns, query) => {
        const empty = query.get('term') ? immutable.List() : immutable.Map()
        const query_id = String(query.hashCode())
        let result = results.filter(r => r.reference === query_id)
        if (result.length === 0) {
          return returns.set(query, empty)
        }
        if (!query.get('multi')) {
          result = result[0]
        } else {
          result = result.reduce((p, r) =>
            Object.assign(p, {items: p.items.concat(r.items)})
          )
        }
        if (result == null || result.items.length === 0) {
          return returns.set(query, empty)
        }
        let response
        if (query.get('term')) {
          response = immutable.List(
            result.items.map(i =>
              toPart(query, i).set(
                'type',
                query.get('multi') ? 'match' : 'search'
              )
            )
          )
        } else {
          response = toPart(query, result.items[0]).set('type', 'match')
        }
        return returns.set(query, response)
      }, immutable.Map())
    })
    .catch(err => console.error(err))
}

const specImportance = immutable.fromJS([
  ['color', 'capacitance', 'resistance'],
  ['case_package'],
  ['dielectric_characteristic'],
  ['resistance_tolerance', 'capacitance_tolerance'],
  ['voltage_rating', 'power_rating'],
  ['pin_count'],
  ['case_package_si'],
])

function getImportance(spec) {
  const key = spec.get('key')
  const importance = specImportance.findIndex(l => l.includes(key))
  if (importance === -1) {
    return specImportance.size
  }
  return importance
}

function sortByImportance(specs) {
  return specs.sort((spec1, spec2) => {
    return getImportance(spec1) - getImportance(spec2)
  })
}

function toPart(query, item) {
  let specs = immutable
    .Map(item.specs)
    .map((spec, key) => {
      return immutable.Map({
        key,
        name: spec.metadata.name,
        value: spec.display_value,
      })
    })
    .toList()
  specs = sortByImportance(specs)
  const number = query.getIn(['mpn', 'part']) || item.mpn
  const manufacturer = query.getIn(['mpn', 'manufacturer']) || item.brand.name
  return immutable.Map({
    mpn: immutable.Map({
      part: number,
      manufacturer,
    }),
    description: item.short_description,
    image: image(item),
    datasheet: datasheet(item),
    offers: offers(item),
    specs,
  })
}

function image(item) {
  return item.imagesets.reduce((prev, set) => {
    if (prev != null) {
      return prev
    }
    if (set.medium_image && set.medium_image.url) {
      return immutable.Map({
        url: set.medium_image.url,
        credit_string: set.credit_string,
        credit_url: set.credit_url,
      })
    }
    return null
  }, null)
}

function datasheet(item) {
  return item.datasheets.reduce((prev, d) => prev || d.url, null)
}

function offers(item) {
  const offers = immutable
    .Set(item.offers)
    .filter(o => retailers_used.includes(o.seller.name))
    .map(offer => {
      const vendor = retailer_map.get(offer.seller.name)
      let part = offer.sku || ''
      if (vendor !== 'Digikey') {
        part = part.replace(/-/g, '')
      }
      return immutable.fromJS({
        sku: {
          part,
          vendor,
        },
        prices: offer.prices,
        in_stock_quantity: offer.in_stock_quantity,
        moq: offer.moq,
      })
    })
  return mergeOffers(offers)
}

function mergeOffers(offers) {
  return offers.reduce((offers, offer) => {
    const sku = offer.get('sku')
    const existing_offer = offers.find(o => o.get('sku').equals(sku))
    if (existing_offer) {
      offers = offers.delete(existing_offer)
      offer = existing_offer.update('prices', ps =>
        ps.concat(offer.get('prices'))
      )
    }
    return offers.add(offer)
  }, immutable.Set())
}

function flatten(l) {
  return l.reduce((p, x) => {
    if (immutable.List.isList(x)) {
      return p.concat(flatten(x))
    }
    return p.push(x)
  }, immutable.List())
}

module.exports = octopart
