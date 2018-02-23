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
      const c = electroGrammar.parse(term)
      // pass through hole and electrolytics on to octopart for now
      if (c.type === 'capacitor' && (/electro/i.test(term) || /pol/i.test(term))) {
        return query
      } else if ((c.type === 'resistor' || c.type === 'led') && /thr/i.test(term)) {
        return query
      }
      const ids = electroGrammar.matchCPL(c)

      const components = cpl[c.type]

      const results = ids
        .map(id => {
          return components.reduce((prev, r) => {
            if (prev) {
              return prev
            } else if (r.cplid === id) {
              return r
            }
          }, null)
        })
        .filter(x => x)

      const mpns = results
        .reduce((p, r) => p.concat(r.partNumbers), [])
        .map(mpn => ({mpn}))
      if (mpns.length > 0) {
        return query.remove('term').set('multi', immutable.fromJS(mpns))
      }
    }
    return query
  })
}

module.exports = checkCPL