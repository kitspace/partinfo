const octopart = require('./octopart')
const lcsc = require('./lcsc')

function search(queries) {
  return Promise.all([octopart(queries), lcsc(queries)]).then(
    ([octopart_responses, lcsc_responses]) => {
      return octopart_responses
    }
  )
}

module.exports = search
