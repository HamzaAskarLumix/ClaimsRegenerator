const AWS = require('aws-sdk');
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const { v4: uuidv4 } = require('uuid');

module.exports.regenerateClaim = async (event) => {
    try {
        let body;
        if (typeof event.body === 'string') {
            body = JSON.parse(event.body);
        } else if (typeof event.body === 'object') {
            body = event.body;
        } else {
            throw new Error('Invalid event body format');
        }

        const { companyId, timesheetId, updatedFields, reason } = body;
        
        if (!companyId || !timesheetId) {
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Credentials': true,
                },
                body: JSON.stringify({ message: 'Both companyId and timesheetId are required' })
            };
        }

        if (!reason) {
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Credentials': true,
                },
                body: JSON.stringify({ message: 'Reason for resubmission is required' })
            };
        }

        console.log('Getting original claim:', { companyId, timesheetId });

        // Get the original claim
        const getParams = {
            TableName: 'timesheetstrings',
            Key: {
                companyId: companyId,
                timesheetId: timesheetId
            }
        };
        
        const existingClaim = await dynamoDB.get(getParams).promise();
        
        if (!existingClaim.Item) {
            return {
                statusCode: 404,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Credentials': true,
                },
                body: JSON.stringify({ message: 'Claim not found' })
            };
        }

        console.log('Found existing claim:', existingClaim.Item);

        // Generate new timesheet ID for the resubmitted claim
        const newTimesheetId = uuidv4();
        const timestamp = new Date().toISOString();

        // Create version tracking information
        const versionInfo = {
            version: (existingClaim.Item.version || 1) + 1,
            originalClaimId: existingClaim.Item.originalClaimId || existingClaim.Item.timesheetId,
            previousVersion: {
                timesheetId: existingClaim.Item.timesheetId,
                version: existingClaim.Item.version || 1,
                timestamp: existingClaim.Item.updatedAt,
                status: existingClaim.Item.billingStatus
            }
        };

        // Create change tracking information
        const changes = Object.entries(updatedFields).map(([field, newValue]) => ({
            field,
            oldValue: existingClaim.Item[field],
            newValue,
            timestamp
        }));

        // Create the new claim
        const newClaim = {
            ...existingClaim.Item,
            ...updatedFields,
            timesheetId: newTimesheetId,
            billingStatus: 'Submitted',
            version: versionInfo.version,
            originalClaimId: versionInfo.originalClaimId,
            resubmittedFrom: {
                companyId: companyId,
                timesheetId: timesheetId,
                version: existingClaim.Item.version || 1,
                timestamp,
                reason,
                changes
            },
            resubmissionHistory: [
                ...(existingClaim.Item.resubmissionHistory || []),
                {
                    type: 'resubmittedFrom',
                    companyId: companyId,
                    timesheetId: timesheetId,
                    version: existingClaim.Item.version || 1,
                    timestamp,
                    reason,
                    changes,
                    status: existingClaim.Item.billingStatus
                }
            ],
            versionHistory: [
                ...(existingClaim.Item.versionHistory || []),
                {
                    version: versionInfo.previousVersion.version,
                    timesheetId: versionInfo.previousVersion.timesheetId,
                    timestamp: versionInfo.previousVersion.timestamp,
                    status: versionInfo.previousVersion.status,
                    changes: existingClaim.Item.resubmittedFrom ? existingClaim.Item.resubmittedFrom.changes : []
                }
            ],
            updatedAt: timestamp,
            createdAt: existingClaim.Item.createdAt || timestamp
        };

        console.log('Creating new claim:', newClaim);

        // Save the new claim
        const newClaimParams = {
            TableName: 'timesheetstrings',
            Item: newClaim
        };

        await dynamoDB.put(newClaimParams).promise();

        // Update the original claim with reference to the new claim
        const originalClaimUpdate = {
            ...existingClaim.Item,
            billingStatus: 'Resubmitted',
            version: versionInfo.previousVersion.version,
            resubmittedTo: {
                companyId: companyId,
                timesheetId: newTimesheetId,
                version: versionInfo.version,
                timestamp,
                reason,
                changes
            },
            resubmissionHistory: [
                ...(existingClaim.Item.resubmissionHistory || []),
                {
                    type: 'resubmittedTo',
                    companyId: companyId,
                    timesheetId: newTimesheetId,
                    version: versionInfo.version,
                    timestamp,
                    reason,
                    changes,
                    status: 'Submitted'
                }
            ],
            versionHistory: [
                ...(existingClaim.Item.versionHistory || []),
                {
                    version: versionInfo.version,
                    timesheetId: newTimesheetId,
                    timestamp,
                    status: 'Submitted',
                    changes
                }
            ],
            updatedAt: timestamp
        };

        console.log('Updating original claim:', originalClaimUpdate);

        // Update the original claim
        const updateOriginalParams = {
            TableName: 'timesheetstrings',
            Item: originalClaimUpdate
        };

        await dynamoDB.put(updateOriginalParams).promise();

        // Get the full claim chain
        const claimChain = await getClaimChain(companyId, versionInfo.originalClaimId);

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': true,
            },
            body: JSON.stringify({
                message: 'Claim regenerated successfully',
                originalClaim: originalClaimUpdate,
                newClaim: newClaim,
                claimChain
            })
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': true,
            },
            body: JSON.stringify({ 
                message: 'Error regenerating claim',
                error: error.message 
            })
        };
    }
};

// Helper function to get the full chain of claims
async function getClaimChain(companyId, originalClaimId) {
    try {
        // Get the original claim first
        const params = {
            TableName: 'timesheetstrings',
            Key: {
                companyId: companyId,
                timesheetId: originalClaimId
            }
        };

        const originalClaim = await dynamoDB.get(params).promise();
        if (!originalClaim.Item) {
            return null;
        }

        // Initialize the chain with the original claim
        let claimChain = [originalClaim.Item];
        
        // Follow the resubmittedTo chain
        let currentClaim = originalClaim.Item;
        while (currentClaim.resubmittedTo) {
            const nextParams = {
                TableName: 'timesheetstrings',
                Key: {
                    companyId: currentClaim.resubmittedTo.companyId,
                    timesheetId: currentClaim.resubmittedTo.timesheetId
                }
            };
            
            const nextClaim = await dynamoDB.get(nextParams).promise();
            if (!nextClaim.Item) break;
            
            claimChain.push(nextClaim.Item);
            currentClaim = nextClaim.Item;
        }
        
        // Sort claims by version/timestamp
        const sortedClaims = claimChain.sort((a, b) => {
            const versionA = a.version || 1;
            const versionB = b.version || 1;
            return versionA - versionB;
        });

        return {
            originalClaim: sortedClaims[0],
            versions: sortedClaims.map(claim => ({
                version: claim.version || 1,
                timesheetId: claim.timesheetId,
                status: claim.billingStatus,
                timestamp: claim.updatedAt,
                changes: claim.resubmittedFrom?.changes || [],
                reason: claim.resubmittedFrom?.reason
            }))
        };
    } catch (error) {
        console.error('Error getting claim chain:', error);
        return null;
    }
}

module.exports.getClaimChain = async (event) => {
    try {
        const { companyId, timesheetId } = event.queryStringParameters;

        if (!companyId || !timesheetId) {
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Credentials': true,
                },
                body: JSON.stringify({ message: 'Both companyId and timesheetId are required' })
            };
        }

        // Get the original claim first
        const params = {
            TableName: 'timesheetstrings',
            Key: {
                companyId: companyId,
                timesheetId: timesheetId
            }
        };

        const originalClaim = await dynamoDB.get(params).promise();
        if (!originalClaim.Item) {
            return {
                statusCode: 404,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Credentials': true,
                },
                body: JSON.stringify({ message: 'Claim not found' })
            };
        }

        // Initialize the chain with the original claim
        let claimChain = [originalClaim.Item];
        
        // Follow the resubmittedTo chain forward
        let currentClaim = originalClaim.Item;
        while (currentClaim.resubmittedTo) {
            const nextParams = {
                TableName: 'timesheetstrings',
                Key: {
                    companyId: currentClaim.resubmittedTo.companyId,
                    timesheetId: currentClaim.resubmittedTo.timesheetId
                }
            };
            
            const nextClaim = await dynamoDB.get(nextParams).promise();
            if (!nextClaim.Item) break;
            
            claimChain.push(nextClaim.Item);
            currentClaim = nextClaim.Item;
        }

        // Follow the resubmittedFrom chain backward
        currentClaim = originalClaim.Item;
        while (currentClaim.resubmittedFrom) {
            const prevParams = {
                TableName: 'timesheetstrings',
                Key: {
                    companyId: currentClaim.resubmittedFrom.companyId,
                    timesheetId: currentClaim.resubmittedFrom.timesheetId
                }
            };
            
            const prevClaim = await dynamoDB.get(prevParams).promise();
            if (!prevClaim.Item) break;
            
            claimChain.unshift(prevClaim.Item);
            currentClaim = prevClaim.Item;
        }

        // Sort claims by version/timestamp
        const sortedClaims = claimChain.sort((a, b) => {
            const versionA = a.version || 1;
            const versionB = b.version || 1;
            return versionA - versionB;
        });

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': true,
            },
            body: JSON.stringify({
                claims: sortedClaims,
                totalVersions: sortedClaims.length
            })
        };

    } catch (error) {
        console.error('Error getting claim chain:', error);
        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': true,
            },
            body: JSON.stringify({ 
                message: 'Error getting claim chain',
                error: error.message 
            })
        };
    }
};
