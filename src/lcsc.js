const immutable = require('immutable')
const rateLimit = require('promise-rate-limit')
const superagent = require('superagent')
const redis = require('redis')

const {getRetailers} = require('./queries')

const currency_cookies = immutable.Map({
  USD:
    'currency=eyJpdiI6InJOVjRyS3JCdXphUkVnTk1KSTZGb3c9PSIsInZhbHVlIjoiaGluMUZSQ1JBXC9EU1Qxd2dsMTJsNDhxaUZGXC9tUjNzU0V4RDNZN0tDdmZSRDdZdXB0R3ZhVm1XVnlHRFJVZGxvRE1uOEpiUCtrcUNDeG94VTlGcUU4Z1ZUVFAyWGgxUzdvRXRBVWF3am9oNjVkTEhGbFdrbjFNR3pmTGltOGRBS0dFTWdVdm56V2ZYWmdMYkhBQTFKN3c9PSIsIm1hYyI6IjVjZjZkZDExZWNlMmRkOGQ4Y2FlNWI5ZjUyNmEyYTAzZjJlNWQ5MTg5M2EzNjg2OWRhZWMyM2VhZDlhN2NmM2YifQ==',
  EUR:
    'currency=eyJpdiI6Im9rZzRtNUZJOGRQdjVCWmNpQzBMQ3c9PSIsInZhbHVlIjoiU0dzd2dZTW02c0dQYXBIWEtWQVVQRGp3cno3S2JHSTN5c1E0YTFlM3VZZmo1WmJzOHdRSFpMYmt3b1UwOTNXY0xVMWFEREUwQXI1MWs4dWNVNFY5ekZ6MHZteUF1ZzhIVnBleWVZK0oxd0hXOTBhbFpFQUhOYWFuTDJiTDV6c0Z0cDZ0OVduYWpPOEZHdkhiY1BZUW93PT0iLCJtYWMiOiI2Mjk0N2M1MmYyMjdmNTg0Mjk1NzlmMjU2MzUxYjM0MzcwYTNkMTM4MzIwNGE5OWNiMDYxOTAzMTlmMjIwNjg2In0=',
  GBP:
    'currency=eyJpdiI6ImVHalVzZUJDaTFiQXg4ZjhVMGQzRVE9PSIsInZhbHVlIjoiNWdEZnFBTlgzb0t2bHA5WlRIRzh1U0I1WlwvU1RlK0R1ZE9ZdGhLXC9RODlhdFVTUWJJMG1CSXdGS01SRzRJTGxtV01YbFwvZFZQbjFkUVVZd09HUXNTUnRraWc0UFZ6UVFhekhPZFVYMWU1UlVSZ2xLOTc3UHV0MERWNnJnQ1VkbHozcldxUWJYV3R4bjVzVkYrcjVySkN3PT0iLCJtYWMiOiI3MzRhMGQwN2VkODEzMTk0YTEwMDQ0ZmNjZGI0MmJlMzQxMzA0Zjk2MzQ0MjBmMGQ4MTdiOWMzMDg5MTgyNDQ2In0=',
})

const runQuery = rateLimit(30, 1000, async function(term) {
  const url = 'https://lcsc.com/api/global/search'
  return superagent
    .post(url)
    .type('form')
    .query('q=' + term)
    .send({page: 1, order: ''})
    .accept('application/json')
    .set('cookie', currency_cookies.get('GBP'))
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
    queries.map(async q => {
      const retailers = getRetailers(q)
      const term = q.get('term')
      const mpn = q.get('mpn')
      const sku = q.get('sku')
      const is_lcsc_sku = sku != null && sku.get('vendor') === 'LCSC'
      if (!retailers.includes('LCSC') && !is_lcsc_sku) {
        return [q, null]
      }
      let response
      if (term != null) {
        response = await runQuery(term)
      } else if (mpn != null) {
        const s = (mpn.get('manufacturer') + ' ' + mpn.get('part')).trim()
        response = await runQuery(s)
      } else if (is_lcsc_sku) {
        response = await runQuery(sku.get('part'))
      }
      return [q, response]
    })
  )
}

module.exports = lcsc
