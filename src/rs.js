const cheerio = require('cheerio')
const immutable = require('immutable')
const rateLimit = require('promise-rate-limit')
const superagent = require('superagent')

const {ELEMENT14_API_KEYS} = require('../config')

let key_select = 0

function rs(sku) {
  const url = `https://uk.rs-online.com/web/c/?sra=oss&r=t&searchTerm=${sku}`
  return superagent
    .get(url)
    .then(r => {
      if (RegExp('^https://uk.rs-online.com/web/p/').test(r.request.url)) {
        //  we were re-directed: it found an exact match
        const $ = cheerio.load(r.text)

        const stockText = $('.stock-msg-content').text()
        const in_stock_quantity = stockText ? parseInt(stockText, 10) : null

        let part = $(
          '#pagecell > div > div.col-xs-12.prodDescDivLL > div.col-xs-10 > div.col-xs-12.keyDetailsDivLL > ul > li:nth-child(2) > span.keyValue'
        )
          .text()
          .trim()
          .replace(/-/g, '')
        let manufacturer = $(
          '#pagecell > div > div.col-xs-12.prodDescDivLL > div.col-xs-10 > div.col-xs-12.keyDetailsDivLL > ul > li:nth-child(3)'
        )
          .text()
          .trim()
        // rs pro items don't have a manufacturer part on the page so we shift
        // everything along one and use the sku as the part
        if (/rs pro/i.test(part)) {
          manufacturer = part
          part = sku
        }
        const mpn = immutable.Map({manufacturer, part})

        let multipack_quantity = $('.topPriceArea')
          .text()
          .match(/Price \d+ .* of (\d+)/)
        if (multipack_quantity != null) {
          multipack_quantity = multipack_quantity[1]
        }

        return immutable.Map({
          mpn,
          multipack_quantity,
          in_stock_quantity,
        })
      }
    })
    .catch(e => {
      throw e
    })
}

module.exports = rateLimit(10, 1000, rs)
