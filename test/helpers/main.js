global.chai = require('chai')
global.assert = chai.assert
global.expect = chai.expect

chai.should()
chai.config.includeStack = true
chai.use(require('chai-eql-immutable'))

assert.equal = function (a, b, message) {
    const Iterable = require("immutable").Iterable
    if (Iterable.isIterable(a) && Iterable.isIterable(b)) {
        if (!a.equals(b)) {
            expect(a).eql(b, message)
        }
    } else {
        assert.strictEqual(a, b, message)
    }
}

require('./browser')
