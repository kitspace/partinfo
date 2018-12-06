const superagent = require('superagent')
const immutable = require('immutable')
const apikey = require('../config').OCTOPART_API_KEY
const rateLimit = require('promise-rate-limit')

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
      const ret = {}
      let type
      if (q.get('mpn')) {
        type = 'match:'
        ret.mpn = q.getIn(['mpn', 'part'])
        //octopart has some issue with the slash
        ret.brand = q.getIn(['mpn', 'manufacturer']).replace(' / ', ' ')
      } else if (q.get('sku')) {
        type = 'match:'
        ret.sku = q.getIn(['sku', 'part'])
        ret.seller = retailer_reverse_map.get(q.getIn(['sku', 'vendor']))
      } else if (q.get('term')) {
        type = 'search:'
        ret.q = q.get('term')
        ret.limit = 20
      }
      if (q.get('common_parts_matches')) {
        const reference = String(q.hashCode())
        ret.reference = 'search:' + reference
        return immutable.List.of(ret).concat(
          transform(q.get('common_parts_matches')).map(x =>
            Object.assign(x, {reference: 'match:' + reference})
          )
        )
      }
      ret.reference = type + String(q.hashCode())
      return ret
    })
  )
}

const run = rateLimit(3, 1000, function(octopart_queries) {
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
})

function octopart(queries) {
  const octopart_queries = transform(queries)
  const groups = splitIntoChunks(octopart_queries, 20)
  return Promise.all(groups.toArray().map(run))
    .then(responses =>
      responses.reduce((prev, res) => {
        if (res.status !== 200) {
          console.error(res.status, queries)
        }
        if (!res.body || !res.body.results) {
          return prev
        }
        return prev.concat(res.body.results)
      }, [])
    )
    .then(results =>
      queries.reduce((returns, query) => {
        const empty = query.get('term') ? immutable.List() : immutable.Map()
        const query_id = String(query.hashCode())
        let result = results.filter(r => r.reference.split(':')[1] === query_id)
        if (result.length === 0) {
          return returns.set(query, empty)
        }
        if (!query.get('term')) {
          result = result[0]
        } else {
          result = result.reduce(
            (p, r) => {
              return Object.assign(p, {
                items: p.items.concat(
                  r.items.map(i => {
                    return Object.assign(i, {type: r.reference.split(':')[0]})
                  })
                ),
              })
            },
            {items: []}
          )
        }
        if (result == null || result.items.length === 0) {
          return returns.set(query, empty)
        }
        let response = empty
        if (query.get('term')) {
          response = immutable.List(
            result.items.map(i => toPart(query, i).set('type', i.type))
          )
        } else {
          let parts = immutable.List(
            result.items.map(i => toPart(query, i).set('type', 'match'))
          )
          parts = mergeSimilarParts(parts)
          const query_sku = query.get('sku')
          if (query_sku) {
            // make sure the queried sku is actually in the offers, else octopart
            // is bullshitting us
            parts = parts.filter(part =>
              part
                .get('offers')
                .some(offer => offer.get('sku').equals(query_sku))
            )
          }
          response = parts.first() || empty
        }
        return returns.set(query, response)
      }, immutable.Map())
    )
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

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/-/g, '')
    .replace(/ /g, '')
    .replace(/_/g, '')
    .replace(/&/g, 'and')
}

function similarEnoughName(name1, name2) {
  return normalizeName(name1) === normalizeName(name2)
}

function similarEnough(mpnOrSku1, mpnOrSku2) {
  const name1 = mpnOrSku1.get('manufacturer') || mpnOrSku1.get('vendor')
  const name2 = mpnOrSku2.get('manufacturer') || mpnOrSku2.get('vendor')
  const part1 = mpnOrSku1.get('part')
  const part2 = mpnOrSku2.get('part')
  return similarEnoughName(name1, name2) && similarEnoughName(part1, part2)
}

function mergeSimilarParts(parts) {
  parts = parts.reduce((prev, part) => {
    const prevPartIndex = prev.findIndex(p =>
      similarEnough(p.get('mpn'), part.get('mpn'))
    )
    if (prevPartIndex >= 0) {
      return prev.update(prevPartIndex, prevPart =>
        prevPart.update('offers', offers => {
          offers = mergeOffers(offers.concat(part.get('offers')))
          return offers
        })
      )
    }
    return prev.push(part)
  }, immutable.List())
  return parts
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
  const number = item.mpn
  const manufacturer = item.brand.name
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

function splitIntoChunks(list, chunkSize = 1) {
  return immutable
    .Range(0, list.count(), chunkSize)
    .map(chunkStart => list.slice(chunkStart, chunkStart + chunkSize))
}

module.exports = octopart
