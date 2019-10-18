const octopart = require('./octopart')

function search(queries) {
  return octopart(queries)
}

module.exports = {search}
