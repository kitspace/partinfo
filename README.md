# Kitspace Partinfo [![Build Status](https://travis-ci.org/monostable/kitnic-partinfo.svg?branch=master)](https://travis-ci.org/monostable/kitnic-partinfo)

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
curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | sudo apt-key add -
echo "deb https://dl.yarnpkg.com/debian/ stable main" | sudo tee /etc/apt/sources.list.d/yarn.list
sudo apt update && sudo apt install nodejs yarn redis
yarn install
cp config.js.in config.js # and add your API keys in there
```

### Running the server

```
yarn start
```

You should be able to see a [GraphiQL client](https://github.com/graphql/graphiql) when visting `http://localhost:4001/graphql` in your browser.
