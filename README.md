# Kitspace Partinfo [![Build Status](https://travis-ci.org/kitspace/partinfo?branch=dev)](https://travis-ci.org/kitspace/partinfo)

A microservice to get information on electronic components. This is used on [kitspace.org](https://kitspace.org) to get the part information for the BOM popups on project pages and for the [BOM Builder](https://bom-builder.kitspace.org).

![Popup screenshot](popup.png)

## Development

This is a [GraphQL](http://graphql.org/) API, the schema is detailed in [schema.js](src/schema.js). It currently makes use of:

- [Octopart API](https://octopart.com/api/home)
- [element14 API](https://partner.element14.com/docs/Product_Search_API_REST__Description)

You need keys for these APIs. Copy the `config.js.in` file to `config.js` and add them there.

```
cp config.js.in config.js
$EDITOR config.js
```

### Requirements

- [NodeJS](https://nodejs.org/en/download/package-manager) version 8 or higher
- [Yarn](https://yarnpkg.com/en/docs/install) dependency manager
- [Redis](https://redis.io/download) persistent in-memory database (for caching)
- The rest of the dependencies can be obtained by running `yarn install`

#### Quick start for Debian/Ubuntu

```
cp config.js.in config.js
$EDITOR config.js
curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | sudo apt-key add -
echo "deb https://dl.yarnpkg.com/debian/ stable main" | sudo tee /etc/apt/sources.list.d/yarn.list
sudo apt update && sudo apt install nodejs yarn redis
yarn install
```

### Running the server

```
yarn start
```

You should be able to see a [GraphiQL client](https://github.com/graphql/graphiql) when visting `http://localhost:4001/graphql` in your browser. Try this [example query](http://localhost:4001/graphql?query={%0A%20%20part(mpn%3A%20{part%3A%20%22NE555P%22%2C%20manufacturer%3A%20%22Texas%20Instruments%22})%20{%0A%20%20%20%20datasheet%0A%20%20%20%20description%0A%20%20%20%20type%0A%20%20%20%20offers%20{%0A%20%20%20%20%20%20sku%20{%0A%20%20%20%20%20%20%20%20vendor%0A%20%20%20%20%20%20%20%20part%0A%20%20%20%20%20%20}%0A%20%20%20%20%20%20prices%20{%0A%20%20%20%20%20%20%20%20USD%0A%20%20%20%20%20%20%20%20EUR%0A%20%20%20%20%20%20%20%20GBP%0A%20%20%20%20%20%20%20%20SGD%0A%20%20%20%20%20%20}%0A%20%20%20%20}%0A%20%20}%0A}%0A).

Query responses will be cached (and persisted to disk) by Redis. If you want to clear all Redis data run:

```
redis-cli flushall
```

### Tests

There are some automated tests in `integration/test_api.js` that you can run:

```
yarn test
```
