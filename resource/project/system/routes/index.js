'use strict';
const router = require('express').Router();
const chalk = require('chalk');
const { CalmResponse } = require('../core/CalmResponse');
const pluralize = require( 'pluralize' );
const path = require( 'path' );

pluralize.addUncountableRule( 'media' );
pluralize.addUncountableRule( 'auth' );

const fs = require( 'fs' );
const modulesPath = path.resolve( `${__dirname}/../../src/modules` );
const PATHS = fs.readdirSync( modulesPath );
const moduleMapper = [];
const Swagger = require('../helpers/swagger');
const mainSwagger = new Swagger().getTemplate();

// eslint-disable-next-line no-console
console.log( chalk.blueBright('✔ Mapping routes') );
const loadModules = ( basePath, baseRoute, routerPaths ) => {
    routerPaths.forEach( ( module ) => {
        if( module !== 'index.js' ) {
            const moduleRoute = `${ module }.route.js`;
            const moduleSettings = `${ module }.settings.js`;
            let urlPath;
            try {
                // eslint-disable-next-line global-require
                const settings = require( path.resolve( modulesPath, basePath ? `${basePath }/` : '', module, moduleSettings ) );
                if( settings[ 'moduleRoute' ] ) {
                    urlPath = settings[ 'moduleRoute' ];
                }
                // eslint-disable-next-line global-require
                const moduleRouter = require( path.resolve( modulesPath, basePath ? `${basePath }/` : '', module, moduleRoute ) );
                const moduleUrlPath = `/${baseRoute ? `${baseRoute}/` : ''}${urlPath || pluralize.plural( module )}`;
                const swaggerTemplate = new Swagger().getTemplate();

                if(Array.isArray(moduleRouter.stack)) {
                    moduleRouter.stack.forEach((r) => {
                        if (r.route && r.route.path) {
                            const routePath = `/${pluralize.plural(module)}${r.route.path = r.route.path.indexOf(':') !== -1 ? `${r.route.path.replace(':', '{')}}` : r.route.path}`;
                            const param = routePath.indexOf('{') != -1 ? routePath.slice(routePath.indexOf('{') + 1, routePath.length - 1) : undefined;
                            swaggerTemplate.paths[ routePath ] = { ...swaggerTemplate.paths[ routePath ], ...new Swagger().create(param, r.route.stack[ 0 ].method, pluralize.plural(module)) };
                            if(swaggerTemplate.tags.findIndex(e => e.name == pluralize.plural(module)) === -1) {
                                swaggerTemplate.tags.push(
                                    new Swagger().createTag(pluralize.plural(module))
                                );
                            }
                        }
                    });
                }

                router.use( moduleUrlPath, moduleRouter );

                moduleMapper.push( {
                    'Module': module,
                    'Route': `/${baseRoute ? `${baseRoute}/` : ''}${urlPath || pluralize.plural( module )}`,
                    'Mapped': '✔',
                    'API Exposed': '✔'
                } );
                // save module swagger JSON
                if(!fs.existsSync(path.resolve( modulesPath, basePath ? `${basePath }/` : '', module, `${module}.swagger.json`))) {
                    fs.writeFileSync(path.resolve( modulesPath, basePath ? `${basePath }/` : '', module, `${module}.swagger.json` ), JSON.stringify(swaggerTemplate, null, 2));
                }
                
                const moduleSwagger = JSON.parse(fs.readFileSync(path.resolve( modulesPath, basePath ? `${basePath }/` : '', module, `${module}.swagger.json` )));
                mainSwagger.tags.push(...moduleSwagger.tags);
                mainSwagger.paths = { ...mainSwagger.paths, ...moduleSwagger.paths };

            } catch ( e ) {
                if(e.message.includes('Router.use() requires')) {
                    moduleMapper.push( {
                        'Module': module,
                        'Route': '-',
                        'Mapped': '-',
                        'API Exposed': '✘'
                    } );
                    return;
                }
                const subPaths = fs.readdirSync( `${modulesPath}/${basePath ? `${basePath}/` : ''}${module}` ).filter( p => {
                    return fs.lstatSync( path.resolve( modulesPath, basePath ? `${basePath }/` : '', module, p ) ).isDirectory();
                } );
                if( !subPaths.length ) {
                    console.log( e );
                    moduleMapper.push( {
                        'Module': module,
                        'Route': `/${baseRoute ? `${baseRoute}/` : ''}${urlPath || pluralize.plural( module )}`,
                        'Mapped': '✘',
                        'API Exposed': '✔',
                        'Error': `${e.message.substr( 0, 25 )}..`
                    } );
                } else {
                    const newBasePath = `${basePath ? `${basePath}/` : ''}${module}`;
                    const newBaseRoute = `${baseRoute ? `${baseRoute}/` : ''}${urlPath || pluralize.plural( module )}`;
                    loadModules( newBasePath, newBaseRoute, subPaths );
                }
            }
        }
    } );
    // save global swagger JSON
    if(!fs.existsSync(path.resolve( `${__dirname}/../../`, 'swagger.json'))) {
        console.log( chalk.blueBright('✔ Generating swagger') );
        fs.writeFileSync('swagger.json', JSON.stringify(mainSwagger, null, 2));
    }
    
};

router.use((req, res, next) => {
    res.sendCalmResponse = CalmResponse;
    res.sendCalmResponse.bind(res);
    next();
});

loadModules( '', '', PATHS );

// eslint-disable-next-line no-console
console.table( moduleMapper );

// Define API Routes
router.get('/', (req, res) => {
    // res.json({ status: true, message: 'API Running' });
    res.sendCalmResponse({ message: 'API Running' });

});
// Load user Defined Modules Here
console.log(chalk.blueBright('✔ API Modules Loaded'));

module.exports = { apiRoutes: router };
