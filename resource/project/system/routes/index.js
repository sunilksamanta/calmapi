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
// eslint-disable-next-line no-console
console.log( chalk.blueBright('✔ Mapping routes') );
// eslint-disable-next-line no-console


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
            } catch( e ) {
            }

            try {
                // eslint-disable-next-line global-require
                router.use( `/${baseRoute ? `${baseRoute}/` : ''}${urlPath || pluralize.plural( module )}`, require( path.resolve( modulesPath, basePath ? `${basePath }/` : '', module, moduleRoute ) ) );
                // console.log( `/${baseRoute ? `${baseRoute}/` : ''}${urlPath || pluralize.plural( module )}` );
                moduleMapper.push( {
                    'Module': module,
                    'Route': `/${baseRoute ? `${baseRoute}/` : ''}${urlPath || pluralize.plural( module )}`,
                    'Mapped': '✔',
                    'API Exposed': '✔'
                } );

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
                // console.error( e );
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
