const immutable = require('immutable')
const graphqlTools = require('graphql-tools')
const {request_bus, response_bus} = require('./message_bus')

const Mpn = `{
     manufacturer : String!
     part         : String!
}`

const Sku = `{
    vendor : String!
    part   : String!
}`

const schema = `
  type Mpn ${Mpn}
  input MpnInput ${Mpn}

  type Sku ${Sku}
  input SkuInput ${Sku}

  input MpnOrSku {mpn: MpnInput, sku: SkuInput}

  type Query {
    part(mpn: MpnInput, sku: SkuInput): Part
    match(parts: [MpnOrSku]!) : [Part]!
    search(term: String!): [Part]!
  }

  type Part {
     mpn         : Mpn
     image       : Image
     datasheet   : String
     description : String
     offers      : [Offer]
     specs       : [Spec]
     type        : String
  }

  type Offer {
    sku                : Sku
    prices             : Prices
    image              : Image
    description        : String
    specs              : [Spec]
    in_stock_quantity  : Int
    stock_location     : String
    moq                : Int
    multipack_quantity : Int
    product_url        : String
  }

  type Prices {
    USD: [[Float]]
    EUR: [[Float]]
    GBP: [[Float]]
    SGD: [[Float]]
  }

  type Image {
    url           : String
    credit_string : String
    credit_url    : String
  }

  type Spec {
    key   : String
    name  : String
    value : String
  }
`

const resolverMap = {
  Query: {
    part(_, {mpn, sku}) {
      return runPart({mpn, sku})
    },
    match(_, {parts}) {
      return Promise.all(parts.map(runPart))
    },
    search(_, {term}) {
      term = term.trim()
      if (!term) {
        return []
      }
      return run({term})
    },
  },
}

function runPart({mpn, sku}) {
  console.info(
    `got request for ${(mpn && JSON.stringify(mpn)) ||
      (sku && JSON.stringify(sku))}`
  )
  if (!(mpn || sku)) {
    return Promise.reject(Error('Mpn or Sku required'))
  }
  if (sku && sku.vendor !== 'Digikey') {
    sku.part = sku.part.replace(/-/g, '')
  }
  return run({mpn, sku})
}

function makeId() {
  this.id = this.id || 1
  return this.id++
}

function run(query) {
  const id = makeId()
  query.id = id
  query = immutable.fromJS(query)
  const time_stamped = immutable.Map({
    query,
    time: Date.now(),
  })
  return new Promise((resolve, reject) => {
    response_bus.once(id, r => {
      if (query.get('term')) {
        r = r.filter(x => x).filter(x => x.get('mpn'))
      } else if (!r.get('mpn')) {
        return resolve()
      }
      console.info(
        `request for ${query.get('term') ||
          query.getIn(['mpn', 'part']) ||
          query.getIn(['sku', 'part'])} took ${Date.now() -
          time_stamped.get('time')} ms`
      )
      resolve(r.toJS())
    })
    request_bus.emit('request', time_stamped)
  })
}

module.exports = graphqlTools.makeExecutableSchema({
  typeDefs: schema,
  resolvers: resolverMap,
})
