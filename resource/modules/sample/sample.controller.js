'use strict';
const { CalmController } = require( '../../../system/core/CalmController' );
const { SampleService } = require( './sample.service' );
const { Sample } = require( './sample.model' );
const sampleDTO = require( './sample.dto' );
const autoBind = require( 'auto-bind' ),
    sampleService = new SampleService(
        new Sample().getInstance()
    );

class SampleController extends CalmController {

    constructor( service ) {
        super( service );
        this.dto = { ...this.dto, ...sampleDTO };
        autoBind( this );
    }

}

module.exports = new SampleController( sampleService );
