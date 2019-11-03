const immutable = require('immutable')
const graphqlFields = require('graphql-fields')
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

const typeDefs = `
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
     specs       : [Spec]
     type        : String
     offers(from: [String]) : [Offer]
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

const resolvers = {
  Query: {
    part(_, {mpn, sku}, __, info) {
      const fields = getFields(info)
      return runPart({mpn, sku, fields})
    },
    match(_, {parts}, __, info) {
      const fields = getFields(info)
      return Promise.all(parts.map(part => runPart({fields, ...part})))
    },
    search(_, {term}, __, info) {
      const fields = getFields(info)
      term = term.trim()
      if (!term) {
        return []
      }
      return run({term, fields})
    },
  },
}

function runPart({mpn, sku, fields}) {
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
  return run({mpn, sku, fields})
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
      } else if (r == null || !r.get('mpn')) {
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

const offerFields = immutable.List.of('prices', '__arguments')

function getFields(info) {
  let fields = graphqlFields(info, {}, {processArguments: true})

  // only keep things that will actually change partinfo behaviour
  fields = immutable
    .fromJS(fields)
    .filter((_, k) => k === 'offers')
    .update(
      'offers',
      offers => offers && offers.filter((_, k) => offerFields.includes(k))
    )
    .filter(offers => offers.size > 0)

  // coerce and sort to help caching
  // XXX needs to be updated if more arguments are added
  fields = fields
    .updateIn(
      ['offers', '__arguments', 0, 'from', 'value'],
      from =>
        from &&
        (typeof from === 'string' ? immutable.List.of(from) : from.sort())
    )
    .removeIn(['offers', '__arguments', 0, 'from', 'kind'])

  return fields
}

module.exports = graphqlTools.makeExecutableSchema({typeDefs, resolvers})
