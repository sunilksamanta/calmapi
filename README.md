# Calm API
### Production ready Modular REST API generator using NodeJS & MongoDB
![Calm API](https://repository-images.githubusercontent.com/352502404/d0e11c00-dce4-11eb-80de-9959e403a244)

[![npm version](https://badge.fury.io/js/calmapi.svg)](https://badge.fury.io/js/calmapi)
![David](https://img.shields.io/david/sunilksamanta/calmapi)

### INSTALLATION
Install by running 
```shell
npm i -g calmapi
```
Then run inside your workspace directory 
```shell
calmapi
```
And follow the easy steps.

### MODULE GENERATION
Generate CalmAPI CRUD Module just by running the following inside project's root.
```shell
calmapi generate module product
```

Valid Module generation commands.

```shell
calmapi generate module product
```
```shell
calmapi generate module products
```
```shell
calmapi generate module productMeta
```
```shell
calmapi generate module ProductMeta
```
```shell
calmapi generate module product-meta
```

### FEATURES
* Production ready - Controller, Model & Service oriented architecture
* Modules with automated Routing (Nested Route support)
* Built-in Authentication Module with JWT & DB Store authentication
* Built-in User Module
* Built-in Media Module for file upload [AWS S3 Support]
* Build-in CRUD operations for modules with pagination, filters, sorters
* Sample Post Module (CRUD Operation Example)
* **CRUD Module generation command line support.**
* No Hidden sh*ts in your node_modules. Completely free to customize
* Prebuilt CRUD operation classes for Controller & Service
* DTO Support( Data transfer Object)
* Eslint rules enabled
* .env support
* And many more

### Contributors
* [Sunil Kr. Samanta](https://github.com/sunilksamanta)
* [Rajdip Mondal](https://github.com/RajdipM)

*We love your input! We want to make contributing to this project as easy and transparent as possible, whether it's: Reporting a bug, Documentation, Discussing the current state of the code, Submitting a fix or Proposing new features.*

### Credits
[Thiago Pacheco](https://github.com/pachecoio) for the idea of better NodeJS architechture.
