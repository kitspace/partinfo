const immutable = require('immutable')
const octopart = require('./octopart')
const lcsc = require('./lcsc')

function search(queries) {
  return Promise.all([octopart(queries), lcsc(queries)]).then(
    ([octopart_responses, lcsc_responses]) => {
      let {merged, remaining_lcsc} = merge(octopart_responses, lcsc_responses)
      return merged.merge(remaining_lcsc).mapEntries(([query, response]) => {
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
  const merged = octopart_responses
    .filter(r => r && r.get('offers'))
    .mapEntries(([query, response]) => {
      const lcsc_response = lcsc_responses.get(query)
      if (lcsc_response != null && lcsc_response.get('offers')) {
        remaining_lcsc = remaining_lcsc.remove(query)
        // overwrite octopart offer data with the more up-to-date better data from lcsc
        const lcsc_offers = lcsc_response.get('offers')
        const lcsc_skus = lcsc_offers.map(o => o.get('sku'))
        const offers = response
          .get('offers')
          .filter(o => !lcsc_skus.find(sku => sku.equals(o.get('sku'))))
          .concat(lcsc_offers)
        response = response.set('offers', offers)
        return [query, response]
      }
    })
  return {merged, remaining_lcsc}
}

module.exports = search
