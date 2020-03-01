const immutable = require('immutable')
const octopart = require('./octopart')
const lcsc = require('./lcsc')
const {getRetailers} = require('./queries')

function search(queries) {
  return Promise.all([octopart(queries), lcsc(queries)]).then(
    async ([octopart_responses, lcsc_responses]) => {
      // duplicate jlc assembly parts as separate offers
      lcsc_responses = lcsc_responses.map(responses =>
        responses.map(response => {
          return response.update('offers', offers => {
            return offers.reduce((offers, o) => {
              const jlc = o.get('jlc_assembly')
              if (jlc != null) {
                o = o.setIn(['sku', 'vendor'], 'JLC Assembly')
                o = o.set('in_stock_quantity', o.get('jlc_stock_quantity'))
                offers = offers.push(o)
              }
              return offers.push(o)
            }, immutable.List())
          })
        })
      )
      let [merged, remaining_lcsc] = merge(octopart_responses, lcsc_responses)

      // get further octopart information by searching mpns of parts we only found at lcsc
      const further_octopart = remaining_lcsc
        .map((response, query) =>
          response.map(part =>
            immutable.Map({
              original_query: query,
              mpn: part.get('mpn'),
              fields: query.get('fields'),
            })
          )
        )
        .flatten(1)
      let rs = await octopart(further_octopart)
      rs = rs.entrySeq().reduce((rs, [query, response]) => {
        query = query.get('original_query')
        const type = query.get('term') ? 'search' : 'match'
        response = response.map(r => r.set('type', type))
        if (rs.get(query)) {
          rs = rs.update(query, rs => rs.concat(response))
        }
        return rs.set(query, response)
      }, immutable.Map())
      merged = concatResponses(rs, merged)
      ;[merged, remaining_lcsc] = merge(merged, remaining_lcsc)

      merged = concatResponses(merged, remaining_lcsc)
      return merged
        .map((response, query) => {
          // filter out according to 'from' argument of offers
          const retailers = getRetailers(query)
          const filterOffers = part =>
            part.update(
              'offers',
              offers =>
                offers &&
                offers.filter(o =>
                  retailers.includes(o.getIn(['sku', 'vendor']))
                )
            )
          return response.map(filterOffers)
        })
        .mapEntries(([query, response]) => {
          if (!query.get('term') && immutable.List.isList(response)) {
            return [query, response.first()]
          }
          return [query, response]
        })
    }
  )
}

function concatResponses(a, b) {
  return immutable.Map(
    a
      .keySeq()
      .concat(b.keySeq())
      .map(key => {
        const as = a.get(key)
        const bs = b.get(key)
        if (as != null && bs != null) {
          return [key, as.concat(bs)]
        }
        return [key, as || bs]
      })
  )
}

function merge(octopart_responses, lcsc_responses) {
  let remaining_lcsc = lcsc_responses
  let merged = octopart_responses.mapEntries(([query, response]) => {
    const lcsc_response = lcsc_responses.get(query)
    if (lcsc_response != null) {
      response = response.map(part => {
        const lcsc_part = lcsc_response.find(p =>
          p.get('mpn').equals(part.get('mpn'))
        )
        if (lcsc_part != null && lcsc_part.get('offers').size > 0) {
          const lcsc_offers = lcsc_part.get('offers')
          remaining_lcsc = remaining_lcsc.update(query, r =>
            r.filterNot(p => p.get('mpn').equals(part.get('mpn')))
          )
          // overwrite octopart offer data with the more up-to-date better data from lcsc
          const lcsc_skus = lcsc_offers.map(o => o.get('sku'))
          const offers = part
            .get('offers')
            .filter(o => !lcsc_skus.find(sku => sku.equals(o.get('sku'))))
            .concat(lcsc_offers)
          part = part.set('offers', offers)
          if (!part.get('description')) {
            part = part.set('description', lcsc_part.get('description'))
          }
          if (!part.get('specs') || part.get('specs').size === 0) {
            part = part.set('specs', lcsc_part.get('specs'))
          }
          if (!part.get('datasheet')) {
            part = part.set('datasheet', lcsc_part.get('datasheet'))
          }
          if (!part.get('image')) {
            part = part.set('image', lcsc_part.get('image'))
          }
        }
        return part
      })
    }
    return [query, response]
  })
  remaining_lcsc = remaining_lcsc.filterNot(
    (response, query) => response.size === 0 && merged.keySeq().includes(query)
  )
  merged = merged.filterNot(
    (response, query) =>
      response.size === 0 && remaining_lcsc.keySeq().includes(query)
  )
  return [merged, remaining_lcsc]
}

module.exports = search
