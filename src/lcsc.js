const immutable = require('immutable')
const rateLimit = require('promise-rate-limit')
const superagent = require('superagent')
const redis = require('redis')

const runQuery = rateLimit(30, 1000, async function(term) {
  const url = 'https://lcsc.com/api/global/search'
  return superagent
    .post(url)
    .type('form')
    .query('q=' + term)
    .send({page: 1, order: ''})
    .accept('application/json')
    .then(r => {
      if (r.status !== 200) {
        console.error(r.status)
      }
      const result = r.body.result
      console.log(JSON.stringify(result, null, 2))
    })
})

function lcsc(queries) {
  return Promise.all(
    queries.map(q => {
      const term = q.get('term')
      const mpn = q.get('mpn')
      const sku = q.get('sku')
      if (term != null) {
        return runQuery(term)
      } else if (mpn != null) {
        let q = mpn.get('manufacturer') + ' ' + mpn.get('part')
        q = q.trim()
        return runQuery(q)
      } else if (sku != null && sku.get('vendor') === 'LCSC') {
        return runQuery(sku.get('part'))
      }
    })
  )
}

module.exports = lcsc
