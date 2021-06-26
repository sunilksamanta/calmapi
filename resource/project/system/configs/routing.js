'use strict';
const { apiRoutes } = require('../routes');
const { CalmError } = require('../core');
const packageJson = require('../../package.json');
const humanizeString = require( 'humanize-string' );
const { sanitizerMiddleware } = require('../helpers/sanitizer-middleware');

module.exports.setRoutes = (app) => {

    /**
     * Application Root Route.
     * Set the Welcome message or send a static html or use a view engine.
     */
    app.get('/', (req, res) => {
        res.json({ status: true, message: `Welcome to the ${packageJson.name}` });
    });

    /**
     * Sanitize Data before passing to the Routes
     */
    app.use(sanitizerMiddleware);

    /**
     * API Route.
     * All the API will start with "/api/[MODULE_ROUTE]"
     */
    app.use('/api', apiRoutes);

    /**
     * Serving Static files from uploads directory.
     */
    // app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

    /**
     * If No route matches. Send user a 404 page
     */
    app.use('/*', (req, res, next) => {
        const error = new CalmError('NOT_FOUND_ERROR');
        next(error);
    });
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        // console.log(err);
        // Check if error is not an instance of CalmError
        if (!(err instanceof CalmError)) {

            if ( err.name === 'ValidationError' && err.errors ) {
                err.statusCode = 422;
                // eslint-disable-next-line no-use-before-define
                err.errors = formatMongooseError( err.errors );
                err.message = humanizeString( err.message.split( ':' )[ 0 ].trim() );

                // eslint-disable-next-line no-param-reassign
                err = new CalmError('VALIDATION_ERROR', err.message, null, err.errors);
            } else {
                // Convert this error into CalmError
                // eslint-disable-next-line no-param-reassign
                err = new CalmError(err.message);
            }

        }
        if(process.env.NODE_ENV === 'production') {
            console.error( `[${new Date().toISOString()}]`, req.method, req.url, err.statusCode, err.message);
        } else {
            console.error( `[${new Date().toISOString()}]`, req.method, req.url, err.statusCode, err.message, `\n${err.stack}`);
        }
        res.statusCode = err.statusCode;
        res.json(err);
    });
};

// eslint-disable-next-line func-style
function formatMongooseError( errorsObj ) {
    const errors = {};
    Object.keys( errorsObj ).forEach( key => {
        switch( errorsObj[ key ].kind ) {
            case 'required': errors[ key ] = `${humanizeString( errorsObj[ key ].path )} is required`;
                break;

            case 'unique': errors[ key ] = `${humanizeString( errorsObj[ key ].path )} already exists`;
                break;

            default:
                if( errorsObj[ key ].name === 'CastError' ) {
                    errors[ key ] = `${humanizeString( errorsObj[ key ].path )} is of invalid type`;
                } else {
                    errors[ key ] = errorsObj[ key ].message;
                }
        }
    } );
    return errors;
};
