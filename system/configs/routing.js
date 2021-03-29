'use strict';
const { apiRoutes } = require('../routes');
const { CalmError } = require('../classes');

module.exports.setRoutes = (app) => {

    /**
     * Application Root Route.
     * Set the Welcome message or send a static html or use a view engine.
     */
    app.get('/', (req, res) => {
        res.json({ status: true, message: 'Welcome to the APP' });
    });

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
        const error = new Error('NOT_FOUND_ERROR');
        next(error);
    });
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        // Check if error is not an instance of CalmError
        if (!(err instanceof CalmError)) {
            // Convert this error into CalmError
            // eslint-disable-next-line no-param-reassign
            err = new CalmError(err.message);
        }
        res.statusCode = err.statusCode;
        res.json(err);
    });
};
