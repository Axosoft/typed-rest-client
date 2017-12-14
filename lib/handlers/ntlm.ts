// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import ifm = require('../Interfaces');
import http = require("http");
import https = require("https");
var _ = require("underscore");
var ntlm = require("../opensource/node-http-ntlm/ntlm");

interface INtlmOptions {
    domain: string,
    workstation: string,
    username?:string,
    password?:string
}

export class NtlmCredentialHandler implements ifm.IRequestHandler {
    private _ntlmOptions: INtlmOptions;
    private _username: string;
    private _password: string;

    constructor(username: string, password: string,  workstation?: string, domain?: string) {
        this._ntlmOptions = <INtlmOptions>{};

        this._username = username;
        this._password = password;
        this._ntlmOptions.workstation = workstation || '';
        this._ntlmOptions.domain = domain || '';
        this._ntlmOptions.username = this._username;
        this._ntlmOptions.password = this._password;
    }

    prepareRequest(options:http.RequestOptions): void {
        // No headers or options need to be set.  We keep the credentials on the handler itself.
        // If a (proxy) agent is set, remove it as we don't support proxy for NTLM at this time
        if (options.agent) {
            // TEMPORARILY COMMENTING THIS TO TRY AND USE PROXY.
            delete options.agent;
        }
    }

    canHandleAuthentication(response: ifm.IHttpClientResponse): boolean {
        if (response && response.message.statusCode === 401) {
            // Ensure that we're talking NTLM here
            // Once we have the www-authenticate header, split it so we can ensure we can talk NTLM
            const wwwAuthenticate = response.message.headers['www-authenticate'];

            if (wwwAuthenticate) {
                const mechanisms = wwwAuthenticate.split(', ');
                const index =  mechanisms.indexOf("NTLM");
                if (index >= 0) {
                    // Check specifically for 'NTLM' since www-authenticate header can also contain
                    // the Authorization value to use in the form of 'NTLM TlRMTVNT....AAAADw=='
                    if (mechanisms[index].length == 4) {
                        return true;
                    }
                }
            }
        }
        
        return false;
    }

    // The following method is an adaptation of code found at https://github.com/SamDecrock/node-http-ntlm/blob/master/httpntlm.js
    async handleAuthentication(httpClient,
                               reqInfo: ifm.IRequestInfo, 
                               objs): Promise<ifm.IHttpClientResponse> {
        
        return new Promise<ifm.IHttpClientResponse>(async(resolve, reject) => {
            try {
                // Set up the headers for NTLM authentication
                let keepaliveAgent;
                if (httpClient.isSsl === true) {
                    keepaliveAgent = new https.Agent({ keepAlive: true });
                } else {
                    keepaliveAgent = new http.Agent({ keepAlive: true });
                }

                // The following pattern of sending the type1 message following immediately (in a setImmediate) is
                // critical for the NTLM exchange to happen.  If we removed setImmediate (or call in a different manner)
                // the NTLM exchange will always fail with a 401.
                console.log('sending type 1 message');
                let response: ifm.IHttpClientResponse = await this._sendType1Message(httpClient, reqInfo, objs, keepaliveAgent);
                let that = this;
                setImmediate(async() => {
                    console.log('sending type 3 message');
                    response = await that._sendType3Message(httpClient, reqInfo, objs, keepaliveAgent, response);
                    resolve(response);
                });
            }
            catch (err) {
                reject(err);
            }
        });
    }

    // The following method is an adaptation of code found at https://github.com/SamDecrock/node-http-ntlm/blob/master/httpntlm.js
    private async _sendType1Message(httpClient: ifm.IHttpClient, reqInfo: ifm.IRequestInfo, objs, keepaliveAgent): Promise<ifm.IHttpClientResponse> {
        //console.log('sending to createType1Message: ' + JSON.stringify(this._ntlmOptions));
        console.log('sending type 1 message continued');
        const type1msg = ntlm.createType1Message(this._ntlmOptions);

        const type1options: http.RequestOptions = {
            headers: {
                'Connection': 'keep-alive',
                'Authorization': type1msg
            },
            //timeout: reqInfo.options.timeout || 0,
            agent: keepaliveAgent,
            // don't redirect because http could change to https which means we need to change the keepaliveAgent
            //allowRedirects: false
        };

        const type1info = <ifm.IRequestInfo>{};
        type1info.httpModule = reqInfo.httpModule;
        type1info.parsedUrl = reqInfo.parsedUrl;
        type1info.options = _.extend(type1options, _.omit(reqInfo.options, 'headers'));

        // console.log('type1info, about to fail');
        // console.log('type1info.parsedUrl: ' + JSON.stringify(type1info.parsedUrl));
        // console.log('type1info.options: ' + JSON.stringify(type1info.options));

        console.log('type1info.options.headers: ' + JSON.stringify(type1info.options.headers));

        return await httpClient.requestRaw(type1info, objs);
    }

    // The following method is an adaptation of code found at https://github.com/SamDecrock/node-http-ntlm/blob/master/httpntlm.js
    private async _sendType3Message(httpClient: ifm.IHttpClient, 
                                    reqInfo: ifm.IRequestInfo,
                                    objs, 
                                    keepaliveAgent, 
                                    res: ifm.IHttpClientResponse): Promise<ifm.IHttpClientResponse> {

        return new Promise<ifm.IHttpClientResponse>(async(resolve, reject) => {
            if (!res.message.headers && !res.message.headers['www-authenticate']) {
                reject(new Error('www-authenticate not found on response of second request'));
                return;
            }

            // console.log("type 2 raw: " + res.message.headers['www-authenticate']);
            const type2msg = ntlm.parseType2Message(res.message.headers['www-authenticate']);
            // console.log("[OURS] parseType2Message completed: " + JSON.stringify(type2msg));

            // console.log('[OURS] createType3Message');
            // console.log('msg2: ' + JSON.stringify(type2msg));
            // console.log('options: ' + JSON.stringify(this._ntlmOptions));
            const type3msg = ntlm.createType3Message(type2msg, this._ntlmOptions);

            // console.log('type3msg: ' + type3msg);
            
            const type3options: http.RequestOptions = {
                headers: {
                    'Authorization': type3msg,
                    'Connection': 'close'
                },
                //allowRedirects: false,
                agent: keepaliveAgent
            };

            //console.log('type3options: ' + JSON.stringify(type3options));

            const type3info = <ifm.IRequestInfo>{};
            type3info.httpModule = reqInfo.httpModule;
            type3info.parsedUrl = reqInfo.parsedUrl;
            
            // pass along other options:
            type3options.headers = _.extend(type3options.headers, reqInfo.options.headers);
            type3info.options = _.extend(type3options, _.omit(reqInfo.options, 'headers'));
            // send type3 message to server:

            //console.log('type3info: ' + JSON.stringify(type3info));
            // console.log('objs: ' + objs);
            //console.log('parsedUrl: ' + reqInfo.parsedUrl);
            //console.log('type3info.options: ' + JSON.stringify(type3info.options));
            //console.log('objs json: ' + JSON.stringify(objs));
            console.log('[OURS] type3info.options.headers: ' + JSON.stringify(type3info.options.headers));

            const type3res: ifm.IHttpClientResponse = await httpClient.requestRaw(type3info, objs);
            resolve(type3res);
        });
    }
}