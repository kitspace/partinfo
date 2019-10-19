const immutable = require('immutable')
const rateLimit = require('promise-rate-limit')
const superagent = require('superagent')
const redis = require('redis')

const {createHeadless} = require('./headless')

const browserPromise = createHeadless()

const runQuery = rateLimit(30, 1000, async function(term) {
  const browser = await browserPromise
  const url = 'https://lcsc.com/search?q=' + term
  console.log({url})
  const page = await browser.newPage()
  await page.goto(url)
  await page.waitFor('.el-table__row')
  const parts = await page.evaluate(() => {
    let rows = document.querySelectorAll('.el-table__row')
    rows = Array.from(rows)
    // the rows seem to be copied 3 times, we discard a third
    rows = rows.slice(0, rows.length / 3)
    return rows.map(row => {
      const part = row.querySelector('.mfrPartItem > a').innerText
      const manufacturer = row.querySelector('.manufacturerItem > a').innerText
      let in_stock_quantity = row.querySelector('.stockItem > a > .text-num')
      if (in_stock_quantity == null) {
        in_stock_quantity = 0
      } else {
        in_stock_quantity = parseInt(in_stock_quantity.innerText, 10)
      }
      let priceRows = row.querySelector('.priceItem').children
      priceRows = Array.from(priceRows).slice(0, -1).map(priceRow => {
        let num = priceRow.querySelector('.num')
        if (num != null) {
          num = parseInt(num.innerHTML, 10)
        }
        let price = priceRow.querySelector('.price')
        if (price != null) {
          price = parseFloat(price.innerHTML.slice(1))
        }
        return [num, price]
      })
      return {part, manufacturer, in_stock_quantity, priceRows}
    })
  })
  console.log(JSON.stringify(parts, null, 2))
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
