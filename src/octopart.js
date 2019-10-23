const superagent = require('superagent')
const immutable = require('immutable')
const apikey = require('../config').OCTOPART_API_KEY
const rateLimit = require('promise-rate-limit')
const electroGrammar = require('electro-grammar')
const RateLimiter = require('async-ratelimiter')
// TODO, only use one redis client
const Redis = require('ioredis')
const redis = require('redis')

const {OCTOPART_CACHE_TIMEOUT_S} = require('../config')

const redisClient = redis.createClient()

const limiter = new RateLimiter({
  db: new Redis(),
  // 1000 requests in 30 days
  max: 1000,
  duration: 30 * 24 * 60 * 60 * 1000, // milliseconds
})

const retailer_map = immutable.OrderedMap({
  'Digi-Key': 'Digikey',
  Mouser: 'Mouser',
  'RS Components': 'RS',
  Newark: 'Newark',
  'element14 APAC': 'Farnell',
  Farnell: 'Farnell',
})

const retailer_reverse_map = retailer_map.mapEntries(([k, v]) => [v, k])
const default_retailers = immutable.Set.fromKeys(retailer_map)

function transform(queries) {
  return flatten(
    queries.map(q => {
      const ret = {limit: 3}
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
        if (q.get('electro_grammar')) {
          ret.electro_grammar = q.get('electro_grammar').toJS()
        }
      }
      if (q.get('common_parts_matches')) {
        const reference = String(q.hashCode())
        ret.reference = 'search:' + reference
        return immutable.List.of(ret).concat(
          transform(q.get('common_parts_matches')).map(x =>
            Object.assign(x, {reference: 'cpl_match:' + reference})
          )
        )
      }
      ret.reference = type + String(q.hashCode())
      return ret
    })
  )
}

const run = rateLimit(3, 1000, async function(query) {
  const limit = await limiter.get({id: 'dev-partinfo'})
  console.info('octopart limit', limit)
  if (limit.remaining === 0) {
    throw new Error('Octpart query limit reached.')
  }
  if (immutable.List.isList(query)) {
    return superagent
      .get('https://octopart.com/api/v3/parts/match')
      .query(
        'include[]=specs&include[]=short_description&include[]=imagesets&include[]=datasheets'
      )
      .query({
        apikey,
        queries: JSON.stringify(query),
      })
      .set('Accept', 'application/json')
  }

  const p = superagent
    .get('https://octopart.com/api/v3/parts/search')
    .query(
      'include[]=specs&include[]=short_description&include[]=imagesets&include[]=datasheets'
    )
    .query({
      q: query.q,
      limit: query.limit,
      apikey,
    })
    .accept('application/json')
  for (const filter of query.filters) {
    p.query(filter)
  }
  return p
})

function transformSearchQueries(queries) {
  return queries.map(query => {
    const reference = query.reference
    const filters = filtersFromElectroGrammar(query.electro_grammar)
    const q = query.electro_grammar.type + ' ' + query.electro_grammar.ignored
    return {q, filters, reference, limit: 20}
  })
}

function filtersFromElectroGrammar(eg) {
  const filters = []
  if (eg.size != null) {
    filters.push('filter[queries][]=specs.case_package.value:' + eg.size)
  }
  if (eg.resistance != null) {
    filters.push('filter[queries][]=specs.resistance.value:' + eg.resistance)
  }
  if (eg.power_rating != null) {
    filters.push(
      `filter[queries][]=specs.power_rating.value:[${eg.power_rating}+TO+*]`
    )
  }
  if (eg.capacitance != null) {
    filters.push('filter[queries][]=specs.capacitance.value:' + eg.capacitance)
  }
  if (eg.characteristic != null) {
    filters.push(
      'filter[queries][]=specs.dielectric_characteristic.value:' +
        eg.characteristic
    )
  }
  if (eg.voltage_rating != null) {
    filters.push(
      `filter[queries][]=specs.voltage_rating_dc.value:[${
        eg.voltage_rating
      }+TO+*]`
    )
  }
  return filters
}

function cacheResponses(responses) {
  responses.forEach(([_, response]) => {
    if (
      response.status === 200 &&
      response.body &&
      response.body.request &&
      response.body.results
    ) {
      let key, result
      if (response.body.request.__class__ === 'SearchRequest') {
        key = queryToKey(response.body.request)
        result = JSON.stringify(response.body.results)
        redisClient.set(key, result, 'EX', OCTOPART_CACHE_TIMEOUT_S)
      } else {
        response.body.request.queries.forEach((q, i) => {
          key = queryToKey(q)
          result = JSON.stringify(response.body.results[i])
          redisClient.set(key, result, 'EX', OCTOPART_CACHE_TIMEOUT_S)
        })
      }
    }
  })
  return responses
}

function queryToKey(query) {
  const x = immutable
    .fromJS(query)
    .filter(
      (value, k) =>
        k !== 'stats' &&
        k !== 'reference' &&
        k !== '__class__' &&
        k !== 'facet' &&
        !(k === 'sortby' && value === 'score desc') &&
        !(k === 'limit' && value === 10) &&
        value
    )
    .mapEntries(([k, v]) => {
      if (k === 'filter') {
        const filters = v.get('queries').map(q => 'filter[queries][]=' + q)
        return ['filters', filters]
      }
      return [k, v]
    })

  const key = 'octopart:' + x.hashCode()
  return key
}

function resolveCached(queries) {
  return Promise.all(
    queries.map(q => {
      const key = queryToKey(q)
      return new Promise((resolve, reject) => {
        redisClient.get(key, (err, response) => {
          if (err) {
            console.error(err)
          }
          response = JSON.parse(response)
          if (response) {
            if (response.length != null) {
              response.map(r => Object.assign(r, {reference: q.reference}))
            } else {
              response.reference = q.reference
              response = [response]
            }
          }
          resolve([q, response])
        })
      })
    })
  )
    .then(immutable.List)
    .then(rs => rs.filter(([_, r]) => r))
}

async function octopart(queries) {
  const octopart_queries = transform(queries)

  let search_queries = octopart_queries.filter(q => q.electro_grammar)
  search_queries = transformSearchQueries(search_queries)
  const cached_search_results = await resolveCached(search_queries)
  search_queries = search_queries.filter(
    q => !cached_search_results.find(([cached_query, _]) => q === cached_query)
  )

  let part_match_queries = octopart_queries.filter(q => !q.electro_grammar)
  const cached_match_results = await resolveCached(part_match_queries)
  part_match_queries = part_match_queries.filter(
    q => !cached_match_results.find(([cached_query, _]) => q === cached_query)
  )

  const groups = splitIntoChunks(part_match_queries, 20)

  return Promise.all(
    groups.concat(search_queries).map(q =>
      run(q).then(r => {
        if (
          q.filters &&
          q.filters.length > 0 &&
          (!r.body || r.body.hits === 0)
        ) {
          // we have a filtered (i.e. parsed by electro-grammar) response with
          // zero hits, ignore the query string and try again
          q.q = ''
          return run(q).then(r => [q, r])
        }
        return [q, r]
      })
    )
  )
    .then(cacheResponses)
    .then(responses =>
      immutable
        .List(responses)
        .map(([q, res]) => {
          if (res.status !== 200) {
            console.error(res.status, queries)
          }
          if (!res.body || !res.body.results) {
            return [q, null]
          }
          return [q, res.body.results]
        })
        .concat(cached_search_results)
        .concat(cached_match_results)
        .flatMap(([q, results]) => {
          if (results == null) {
            return []
          }
          return immutable.List(results).flatMap(result => {
            if (result.__class__ === 'SearchResult') {
              const [type, reference] = q.reference.split(':')
              return [Object.assign(result.item, {reference, type})]
            }
            if (result.__class__ === 'PartsMatchResult') {
              const [type, reference] = result.reference.split(':')
              return result.items.map(i => Object.assign(i, {reference, type}))
            }
          })
        })
    )
    .then(responses =>
      queries.reduce((previousResults, query) => {
        const empty = query.get('term') ? immutable.List() : immutable.Map()
        const previous = previousResults.get(query) || empty
        const query_id = String(query.hashCode())
        let results = responses.filter(r => r.reference === query_id)
        if (results.length === 0) {
          return previousResults.set(query, previous)
        }
        let response = previous
        if (query.get('term')) {
          let newParts = results.map(i => toPart(query, i))
          // tolerance seems impossible to filter-by through octopart api
          // so we filter out outside-of-tolerance parts here
          const tolerance = query.getIn(['electro_grammar', 'tolerance'])
          if (tolerance) {
            const type = query.getIn(['electro_grammar', 'type'])
            newParts = filterByTolerance(type, tolerance, newParts)
          }
          response = mergeSimilarParts(previous.concat(newParts))
        } else {
          let newParts = immutable.List(results.map(i => toPart(query, i)))
          newParts = mergeSimilarParts(newParts)
          const query_sku = query.get('sku')
          if (query_sku) {
            // make sure the queried sku is actually in the offers, else octopart
            // is bullshitting us
            newParts = newParts.filter(part =>
              part
                .get('offers')
                .some(offer => offer.get('sku').equals(query_sku))
            )
          }
          response = newParts.first() || previous
        }
        return previousResults.set(query, response)
      }, immutable.Map())
    )
    .then(responses =>
      responses.map((response, query) => {
        // filter out according to 'from' argument of offers
        const retailers =
          query.getIn([
            'fields',
            'offers',
            '__arguments',
            0, //XXX needs to be udpated if more arguments are added
            'from',
            'value',
          ]) || default_retailers
        const filterOffers = part =>
          part.update('offers', offers =>
            offers.filter(o => retailers.includes(o.getIn(['sku', 'vendor'])))
          )
        if (immutable.List.isList(response)) {
          return response.map(filterOffers)
        }
        return filterOffers(response)
      })
    )
}

const specImportance = immutable.fromJS([
  ['color', 'capacitance', 'resistance'],
  ['case_package'],
  ['dielectric_characteristic'],
  ['resistance_tolerance', 'capacitance_tolerance'],
  ['power_rating'],
  ['voltage_rating_dc', 'voltage_rating'],
  ['pin_count'],
  ['case_package_si'],
])

function filterByTolerance(type, tolerance, parts) {
  const spec_key =
    type === 'resistor'
      ? 'resistance_tolerance'
      : type === 'capacitor' ? 'capacitance_tolerance' : null
  if (spec_key) {
    return parts.filter(part => {
      const spec = part.get('specs').find(s => s.get('key') === spec_key)
      if (spec) {
        const {tolerance: specTolerance} = electroGrammar.parse(
          '0.1uF ' + spec.get('value')
        )
        if (specTolerance == null) {
          // we didn't understand the tolerance so let's be on the safe side
          return false
        }
        return specTolerance <= tolerance
      }
      return true
    })
  }
  return parts
}

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
        prevPart
          .update('offers', offers => {
            offers = mergeOffers(offers.concat(part.get('offers')))
            return offers
          })
          .update('type', type => {
            return /match/.test(part.get('type')) ? part.get('type') : type
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
    type: item.type,
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
  let d = item.datasheets.reduce((prev, d) => prev || d.url, null)
  if (d != null) {
    d = d.replace(apikey, '')
  }
  return d
}

function offers(item) {
  const offers = immutable.Set(item.offers).map(offer => {
    const vendor = retailer_map.get(offer.seller.name) || offer.seller.name
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
      multipack_quantity: offer.multipack_quantity,
      moq: offer.moq,
      product_url: offer.product_url.replace(apikey, ''),
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
