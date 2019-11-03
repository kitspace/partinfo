const immutable = require('immutable')
const octopart = require('./octopart')
const lcsc = require('./lcsc')
const {getRetailers} = require('./queries')

function search(queries) {
  return Promise.all([octopart(queries), lcsc(queries)]).then(
    async ([octopart_responses, lcsc_responses]) => {
      let [merged, remaining_lcsc] = merge(octopart_responses, lcsc_responses)
      const further_octopart = remaining_lcsc
        .map((response, query) =>
          response.map(part => {
            const original_query = query
            return query
              .merge({original_query})
              .remove('sku')
              .remove('id')
              .set('mpn', part.get('mpn'))
          })
        )
        .flatten(1)
      let rs = await octopart(further_octopart)
      rs = rs.mapEntries(([query, response]) => [
        query.get('original_query'),
        response,
      ])
      ;[merged, remaining_lcsc] = merge(rs.merge(merged), remaining_lcsc)
      return merged
        .merge(remaining_lcsc)
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

function merge(octopart_responses, lcsc_responses) {
  let remaining_lcsc = lcsc_responses
  let merged = octopart_responses.mapEntries(([query, response]) => {
    const lcsc_response = lcsc_responses.get(query)
    if (lcsc_response != null) {
      response = response.map(part => {
        const lcsc_part = lcsc_response.find(p =>
          p.get('mpn').equals(part.get('mpn'))
        )
        if (lcsc_part != null && lcsc_part.get('offers')) {
          remaining_lcsc = remaining_lcsc.remove(query)
          // overwrite octopart offer data with the more up-to-date better data from lcsc
          const lcsc_offers = lcsc_part.get('offers')
          const lcsc_skus = lcsc_offers.map(o => o.get('sku'))
          const offers = part
            .get('offers')
            .filter(o => !lcsc_skus.find(sku => sku.equals(o.get('sku'))))
            .concat(lcsc_offers)
          part = part.set('offers', offers)
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
