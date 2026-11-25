"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const M = __importStar(require("./models"));
const tenancy_1 = require("./tenancy");
// usage: npm run create-superadmin -- owner@example.com 'a-long-password-12+'
const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 12) {
    console.error('usage: create-superadmin <email> <password (12+ chars)>');
    process.exit(1);
}
(0, tenancy_1.runSystem)(async () => {
    await M.sequelize.sync();
    if (await M.Employee.unscoped().findOne({ where: { email: email.toLowerCase() } }))
        throw new Error('That email already exists');
    await M.Employee.create({ name: 'Platform Owner', email: email.toLowerCase(), role: 'superadmin', status: 'active', companyId: null, password: bcryptjs_1.default.hashSync(password, 12) });
    console.log('Super admin created. Sign in with this email and password.');
}).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
