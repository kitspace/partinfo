const expressGraphql = require('express-graphql')
const express        = require('express')
const cors           = require('cors')
const memwatch = require('memwatch-next')

const schema = require('./schema')
const config = require('../config')

require('./handle_changes')

const hd = new memwatch.HeapDiff()
let leak = 0
memwatch.on('leak', info => {
  console.log('leak', ++leak)
  if (leak > 4) {
    const log = {info}
    log.diff = hd.end()
    console.log(JSON.stringify(log, null, 2))
  }
})

const app = express()

app.options('/graphql', cors())

//allow enabled cross origin requests
app.use('/graphql', (req, res, next) =>  {
    const origin = req.get('origin')
    const allowed = config.ALLOWED_CORS_DOMAINS.reduce((prev, d) => {
      return prev || RegExp(d).test(origin)
    }, false)
    if (allowed) {
        res.header('Access-Control-Allow-Origin', origin)
        res.header('Access-Control-Allow-Methods', 'GET,POST')
        res.header('Access-Control-Allow-Headers', 'Content-Type')
        res.header('Access-Control-Allow-Credentials', 'true')
    }
    return next()
})

app.use('/graphql', expressGraphql((req) =>  {
  return {
    schema,
    graphiql: true,
    rootValue: {},
  }
}))

module.exports = app
