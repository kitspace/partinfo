const redis = require('redis')
const immutable = require('immutable')

const octopart = require('./octopart')
const runRetailers = require('./retailers')
const checkCPL = require('./check_cpl')

const {request_bus, response_bus} = require('./message_bus')

const QUERY_BATCH_SIZE = 20
const QUERY_MAX_WAIT_MS = 100 //milliseconds

const {QUERY_CACHE_TIMEOUT_S, QUERY_KEY_PREFIX} = require('../config')

const redisClient = redis.createClient()

setInterval(checkRequests, 1000)
request_bus.on('request', checkRequests)

let requests = immutable.List()
function checkRequests(r) {
  if (r) {
    requests = requests.push(r)
  }
  return resolveCached(requests).then(queries => {
    requests = queries
    const now = Date.now()
    const timed_out = requests.reduce((timed_out, query) => {
      return timed_out || now - query.get('time') > QUERY_MAX_WAIT_MS
    }, false)
    if (requests.size >= QUERY_BATCH_SIZE || timed_out) {
      requestNew(requests.slice(0, QUERY_BATCH_SIZE))
      requests = requests.slice(QUERY_BATCH_SIZE)
    }
  })
}

function resolveCached(queries) {
  const uncached = queries.map(
    q =>
      new Promise((resolve, reject) => {
        const key = queryToKey(q.get('query'))
        console.log({key})
        redisClient.get(key, (err, response) => {
          if (err) {
            console.error(err)
          }
          if (response) {
            response_bus.emit(q.getIn(['query', 'id']), fromRedis(response))
            return resolve(null)
          }
          return resolve(q)
        })
      })
  )
  return Promise.all(uncached).then(qs => {
    qs = qs.filter(q => q)
    return immutable.List(qs)
  })
}

function requestNew(queries) {
  queries = queries.map(q => q.get('query'))
  console.info('requestNew', queries.toJS())
  queries = checkCPL(queries)
  octopart(queries)
    .then(runRetailers)
    .then(results => {
      cache(results)
      results.forEach((v, k) => {
        response_bus.emit(k.get('id'), v)
      })
    })
    .catch(e => console.error(e))
}

function cache(responses) {
  responses.forEach((v, query) => {
    const key = queryToKey(query)
    const values = toRedis(v)
    redisClient.set(key, values, 'EX', QUERY_CACHE_TIMEOUT_S)
  })
}

function toRedis(response) {
  return JSON.stringify(response)
}

function fromRedis(redis_response) {
  return immutable.fromJS(JSON.parse(redis_response))
}

function queryToKey(query) {
  return QUERY_KEY_PREFIX + query
    .filter(
      (_, k) =>
        k !== 'id' && k !== 'common_parts_matches' && k !== 'electro_grammar'
    )
    .hashCode()
}
