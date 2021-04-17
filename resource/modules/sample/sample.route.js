'use strict';
const SampleController = require( './sample.controller' );
const express = require( 'express' );
const router = express.Router();

router.get( '/', SampleController.getAll );
router.get( '/:id', SampleController.get );
router.post( '/', SampleController.insert );
router.put( '/:id', SampleController.update );
router.delete( '/:id', SampleController.delete );


module.exports = router;
