const immutable = require('immutable')
const electroGrammar = require('electro-grammar')

const cpl = {
  capacitor: require('./cpl/capacitors.json'),
  resistor: require('./cpl/resistors.json'),
  led: require('./cpl/leds.json'),
}

function checkCPL(queries) {
  return queries.map(query => {
    const term = query.get('term')
    if (term != null) {
      const c = electroGrammar.parse(term, {returnIgnored: true})
      if (c.type) {
        query = query.set('electro_grammar', immutable.fromJS(c))
      }
      // don't try and match it if we don't have a package size
      if (c.size == null) {
        return query
      }
      const ids = electroGrammar.matchCPL(c)

      const components = cpl[c.type]

      const results = ids
        .map(id => components.find(x => x.cplid === id))
        .filter(x => x)

      if (results.length > 0) {
        const mpns = results
          .reduce((p, r) => p.concat(r.partNumbers), [])
          .map(mpn => ({mpn}))
        return query.set('common_parts_matches', immutable.fromJS(mpns))
      }
    }
    return query
  })
}

module.exports = checkCPL
