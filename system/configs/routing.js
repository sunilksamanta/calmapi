'use strict';
const apiRoutes = require('../routes');

module.exports.setRoutes = (app) => {

    /**
     * Application Root Route.
     * Set the Welcome message or send a static html or use a view engine.
     */
    app.get('/', (req, res) => {
        res.json({status: true, message: 'Welcome to the APP'});
    });

    /**
     * API Route.
     * All the API will start with "/api/[MODULE_ROUTE]"
     */
    // app.use('/api', apiRoutes);

    /**
     * Serving Static files from uploads directory.
     */
    // app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

    /**
     * If No route matches. Send user a 404 page
     */
    app.use('/*', (req, res, next) => {
        const error = new Error('Requested path does not exist.');
        error.statusCode = 404;
        next(error);
    });

    app.use((err, req, res, next) => {
        console.log(err.message);
        next(err);
    })
};
