const immutable = require('immutable')
const rateLimit = require('promise-rate-limit')
const superagent = require('superagent')
const redis = require('redis')

const {createHeadless} = require('./headless')

const browserPromise = createHeadless()

const runQuery = rateLimit(30, 1000, async function(term) {
  const browser = await browserPromise
  const url = 'https://lcsc.com/search?q=' + term
  const page = await browser.newPage()
  await page.goto(url)
  await page.waitFor('.mfrPartItem')
  const titles = await page.evaluate(() => {
    const ts = document.querySelectorAll('.mfrPartItem')
    return Array.from(ts).map(t => t.innerHTML)
  })
  console.log(titles)
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
