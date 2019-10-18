const cheerio = require('cheerio')
const immutable = require('immutable')
const rateLimit = require('promise-rate-limit')
const superagent = require('superagent')
const redis = require('redis')

const runQuery = rateLimit(30, 1000, function(term) {
  const url = 'https://lcsc.com/search?q=' + term
  console.log({url})
  return superagent.get(url).then(r => {
    const $ = cheerio.load(r.text)
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
        return runQuery(mpn.get('manufacturer') + ' ' + mpn.get('part'))
      } else if (sku != null && sku.get('vendor') === 'LCSC') {
        return runQuery(sku.get('part'))
      }
    })
  )
}

module.exports = lcsc
