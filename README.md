# Kitspace Partinfo [![Build Status](https://travis-ci.org/monostable/kitnic-partinfo.svg?branch=master)](https://travis-ci.org/monostable/kitnic-partinfo)

A microservice to get information on electronic components. This is used on [kitspace.org](https://kitspace.org) to get the part information for the BOM popups on project pages and for the [BOM Builder](https://bom-builder.kitspace.org).

![Popup screenshot](popup.png)

This is a [GraphQL](http://graphql.org/) API, the schema is detailed in [schema.js](src/schema.js). It currently makes use of:

- [Octopart API](https://octopart.com/api/home)
- [element14 API](https://partner.element14.com/docs/Product_Search_API_REST__Description)
