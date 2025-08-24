# Netlify Blobs Migration

This project has been migrated to use Netlify Blobs for file storage instead of local file storage.

## Changes Made

### 1. Added Dependencies
- Added `@netlify/blobs` package for cloud storage

### 2. Storage System
- **In Netlify environment**: Uses Netlify Blobs for storing uploaded and processed files
- **Local development**: Falls back to local file storage in `server/uploads/` directory

### 3. Key Changes in `server/index.js`

#### Dynamic Import Solution
To avoid ES module compatibility issues in Netlify Functions, the `@netlify/blobs` package is loaded using dynamic imports instead of `require()`:
- Uses `await import('@netlify/blobs')` instead of `require('@netlify/blobs')`
- Initializes asynchronously during server startup
- Gracefully falls back to local storage if import fails

#### Storage Initialization
```javascript
// Initialize Netlify Blobs store using dynamic imports (to avoid ES module conflicts)
let store
let getStore

const initializeStore = async () => {
	try {
		const { getStore: _getStore } = await import('@netlify/blobs')
		getStore = _getStore
		store = getStore('uploads')
		console.log('Netlify Blobs store initialized')
	} catch (error) {
		console.log('Not in Netlify environment, will use fallback local storage')
		store = null
		getStore = null
	}
}
```

#### File Processing Flow
1. **Upload**: Files are stored in Netlify Blobs (or local storage as fallback)
2. **Processing**: Files are downloaded to temporary files for conversion
3. **Storage**: Processed files are saved back to Netlify Blobs
4. **Download**: Files are streamed directly from Netlify Blobs to user
5. **Cleanup**: Files are automatically deleted after 5 minutes

#### Benefits
- **Scalability**: No local disk space limitations
- **Reliability**: Cloud-based storage with automatic replication
- **Performance**: Distributed storage for faster access
- **Serverless-friendly**: Works perfectly with Netlify Functions

### 4. Environment Compatibility
- **Netlify Production**: Uses Netlify Blobs automatically
- **Local Development**: Uses local file storage with same API
- **Other Deployments**: Gracefully falls back to local storage

### 5. No Breaking Changes
- All existing API endpoints remain the same
- File upload/download behavior is identical for users
- Automatic migration - no manual intervention required

## Deployment Notes

### ES Module Compatibility
This implementation uses dynamic imports to avoid the common error:
```
Error - require() of ES Module ... not supported
```

The solution:
- Uses `await import('@netlify/blobs')` instead of `require('@netlify/blobs')`
- Initializes the store asynchronously during server startup
- Works correctly in both Netlify Functions and local development

### Netlify Deployment
When deploying to Netlify:
- Netlify Blobs will be automatically available
- No additional configuration required
- Files will be stored in the cloud instead of server disk

For local development:
- Files continue to work as before using local storage
- The `server/uploads/` directory is created automatically
