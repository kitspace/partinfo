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
        let in_stock_quantity = parseInt(stockText, 10)

        if (isNaN(in_stock_quantity)) {
          in_stock_quantity = null
        }

        const discontinued = $('.icon-rs_28-discontinued').html() != null
        const warning = $('.icon-rs_61-warning').html() != null
        if (discontinued || (in_stock_quantity == null && warning)) {
          in_stock_quantity = 0
        }

        let part = $(
          'div.keyDetailsDivLL > ul > li:nth-child(2) > span.keyValue'
        )
          .text()
          .trim()
          .replace(/-/g, '')
        let manufacturer = $(
          'div.keyDetailsDivLL > ul > li:nth-child(3) > span:nth-child(2)'
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

        let moq = $('#value-row-0 > div:nth-child(1)')
          .text()
          .trim()
          .match(/^\d+/)

        if (moq != null) {
          moq = moq[0]
        }

        return immutable
          .Map({
            mpn,
            multipack_quantity,
            moq,
            in_stock_quantity,
          })
          .filter(x => x != null)
      }
    })
    .catch(e => {
      throw e
    })
}

module.exports = rateLimit(30, 1000, rs)
