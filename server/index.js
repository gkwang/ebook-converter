#!/usr/bin/env node
const path = require('path')
const fs = require('fs-extra')
const express = require('express')
const multer = require('multer')
const openccCvtEpub = require('../src/opencc-convert-epub')
const openccCvtText = require('../src/opencc-convert-text')
const zhcCvtEpub = require('../src/zhc-convert-epub')
const zhcCvtText = require('../src/zhc-convert-text')

const DELETE_DELAY = 5 * 60 * 1000 // 5 mins
const app = express()
app.engine('pug', require('pug').__express)
app.set('view engine', 'pug')
app.set('views', __dirname)
app.use('/static', express.static(path.join(__dirname, 'static')))

// Initialize Netlify Blobs store (only when in Netlify environment)
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

// Fallback to local storage when not in Netlify environment
const useLocalStorage = () => !store
const uplDir = path.join(__dirname, 'uploads')

// Initialize store and ensure uploads directory exists
const initialize = async () => {
	await initializeStore()
	if (useLocalStorage()) {
		fs.ensureDirSync(uplDir)
	}
}

// Call initialize function
initialize().catch(console.error)

// Utility functions for blob storage with local fallback
const saveFileToBlob = async (buffer, key, metadata = {}) => {
	if (useLocalStorage()) {
		// Fallback to local storage
		await fs.ensureDir(uplDir)
		const filePath = path.join(uplDir, key)
		await fs.writeFile(filePath, buffer)
		return filePath
	} else {
		await store.set(key, buffer, { metadata })
		return key
	}
}

const loadFileFromBlob = async (key, tempPath) => {
	if (useLocalStorage()) {
		// Copy from local storage
		await fs.copyFile(key, tempPath)
	} else {
		const blob = await store.get(key, { type: 'stream' })
		if (!blob) {
			throw new Error('Blob not found')
		}
		
		return new Promise((resolve, reject) => {
			const writeStream = fs.createWriteStream(tempPath)
			blob.pipe(writeStream)
			writeStream.on('finish', resolve)
			writeStream.on('error', reject)
		})
	}
}

const saveProcessedFileToBlob = async (tempPath, key) => {
	const buffer = await fs.readFile(tempPath)
	const stats = await fs.stat(tempPath)
	
	if (useLocalStorage()) {
		const filePath = path.join(uplDir, key)
		await fs.writeFile(filePath, buffer)
		return filePath
	} else {
		await store.set(key, buffer, { 
			metadata: { 
				size: stats.size,
				processedAt: Date.now()
			}
		})
		return key
	}
}

// Use memory storage for multer when using blobs, disk storage for local fallback
const upload = multer({
	storage: multer.memoryStorage(), // Always use memory storage, we'll handle persistence in middleware
	fileFilter: (req, file, cb) => {
		// fix: https://github.com/expressjs/multer/pull/1102
		file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')
		cb(null, true)
	},
	limits: {
		fileSize: 64 * 1024 * 1024 // 64MB
	}
})

app.get('/', (req, res) => {
	res.set('Cache-control', 'public, max-age=3600')
	res.render('index')
})
const favicon = path.join(__dirname, '/static/favicon.ico')
app.get('/favicon.ico', (req, res) => {
	res.set('Cache-control', 'public, max-age=3600')
	res.sendFile(favicon)
})

const appendFileName = (originalName, text) => {
	const parts = originalName.split('.')
	const ext = parts.pop()
	const name = parts.join('.')
	return name + text + '.' + ext
}
const downloadFile = async (res, fileName, storageKey) => {
	try {
		if (useLocalStorage()) {
			// Use local file
			const { size } = await fs.stat(storageKey)
			res.setHeader('Content-Length', size)
			res.setHeader('X-File-Name', encodeURIComponent(fileName))
			res.attachment(fileName).type('epub')
			return new Promise((resolve, reject) =>
				fs.createReadStream(storageKey).pipe(res).on('finish', resolve).on('error', reject)
			)
		} else {
			// Use blob storage
			const blob = await store.get(storageKey, { type: 'stream' })
			if (!blob) {
				throw new Error('Blob not found')
			}
			
			// Get metadata to set content length
			const metadata = await store.getMetadata(storageKey)
			if (metadata && metadata.size) {
				res.setHeader('Content-Length', metadata.size)
			}
			
			res.setHeader('X-File-Name', encodeURIComponent(fileName))
			res.attachment(fileName).type('epub')
			
			return new Promise((resolve, reject) => {
				blob.on('end', resolve)
				blob.on('error', reject)
				blob.pipe(res)
			})
		}
	} catch (error) {
		throw error
	}
}
const files = Object.create(null)
async function performDelete(file) {
	console.log(`Deleting ${file.id} ...`)
	delete files[file.id]
	
	if (useLocalStorage()) {
		// Delete local files
		try {
			await fs.unlink(file.storageKey)
			console.log(`Successfully deleted local file ${file.storageKey}`)
		} catch (err) {
			console.log(`Deleting local file ${file.id} error: ${err}`)
		}
		
		if (file.originalStorageKey && file.originalStorageKey !== file.storageKey) {
			try {
				await fs.unlink(file.originalStorageKey)
				console.log(`Successfully deleted original local file ${file.originalStorageKey}`)
			} catch (err) {
				console.log(`Deleting original local file ${file.id} error: ${err}`)
			}
		}
	} else {
		// Delete blobs
		try {
			await store.delete(file.storageKey)
			console.log(`Successfully deleted processed blob ${file.storageKey}`)
		} catch (err) {
			console.log(`Deleting processed blob ${file.id} error: ${err}`)
		}
		
		if (file.originalStorageKey) {
			try {
				await store.delete(file.originalStorageKey)
				console.log(`Successfully deleted original blob ${file.originalStorageKey}`)
			} catch (err) {
				console.log(`Deleting original blob ${file.id} error: ${err}`)
			}
		}
	}
}
function addDeleteTask(file) {
	console.log(`Schedule ${file.id} for deletion...`)
	setTimeout(() => {
		performDelete(file)
	}, DELETE_DELAY)
}
app.get('/files/:id', async (req, res) => {
	const file = files[req.params.id]
	if (!file) {
		return res.status(404).send('找不到檔案')
	}
	if (!file.done) {
		return res.status(404).send('檔案還沒準備完成')
	}
	try {
		await downloadFile(res, appendFileName(file.originalName, '-converted'), file.storageKey)
	} catch (error) {
		console.error('Download error:', error)
		return res.status(404).send('檔案下載失敗')
	}
})
app.get('/info/:id', (req, res) => {
	res.set('Cache-control', 'no-cache, no-store, must-revalidate')
	const file = files[req.params.id]
	if (!file) {
		return res.render('info', { file: null })
	}
	res.render('info', { id: req.params.id, file })
})
const handleFileMiddleware = type => [
	upload.single('file'),
	async (req, res, next) => {
		if (!req.file || req.file.mimetype !== type) {
			return res.type('text').send(`檔案類型並非 ${type}`)
		}
		
		const fileId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9)
		let originalStorageKey, processedStorageKey
		
		if (useLocalStorage()) {
			// Use local storage - save file to disk
			const originalFileName = `original-${fileId}`
			const processedFileName = `processed-${fileId}`
			originalStorageKey = path.join(uplDir, originalFileName)
			processedStorageKey = path.join(uplDir, processedFileName)
			
			try {
				await fs.writeFile(originalStorageKey, req.file.buffer)
			} catch (error) {
				console.error('File save error:', error)
				return res.status(500).send('檔案保存失敗')
			}
		} else {
			// Use blob storage
			originalStorageKey = `original-${fileId}`
			processedStorageKey = `processed-${fileId}`
			
			try {
				// Save original file to blob storage
				await saveFileToBlob(req.file.buffer, originalStorageKey, {
					originalName: req.file.originalname,
					mimetype: req.file.mimetype,
					size: req.file.size,
					uploadedAt: Date.now()
				})
			} catch (error) {
				console.error('File upload error:', error)
				return res.status(500).send('檔案上傳失敗')
			}
		}
		
		req.file = files[fileId] = {
			originalName: req.file.originalname,
			originalStorageKey: originalStorageKey,
			storageKey: processedStorageKey,
			generated: Date.now(),
			done: false,
			id: fileId
		}
		
		res.redirect(`/info/${fileId}`)
		next()
	}
]
const handleTaskCompletion = (file, task) =>
	task
		.then(() => {
			console.log(`Conversion of ${file.id} done`)
			file.done = true
			file.generated = Date.now()
			addDeleteTask(file)
		})
		.catch(async () => {
			console.log(`Conversion of ${file.id} failed`)
			file.error = true
			
			// Clean up storage on error
			if (useLocalStorage()) {
				try {
					await fs.unlink(file.originalStorageKey)
					console.log(`Cleaned up original local file ${file.originalStorageKey}`)
				} catch (err) {
					console.log(`Error cleaning up original local file: ${err}`)
				}
			} else {
				try {
					await store.delete(file.originalStorageKey)
					console.log(`Cleaned up original blob ${file.originalStorageKey}`)
				} catch (err) {
					console.log(`Error cleaning up original blob: ${err}`)
				}
			}
			
			setTimeout(() => {
				performDelete(file)
			}, 10 * 1000) // so that the user can see the error message (by redirecting to /info/:id)
		})
// Wrapper function to handle conversion with blob storage or local storage
const processFileWithBlobs = async (file, conversionFunction, config) => {
	if (useLocalStorage()) {
		// For local storage, process in place
		await conversionFunction(file.originalStorageKey, { ...config, dest: file.storageKey })
	} else {
		// For blob storage, use temporary files
		const tempfile = require('tempfile')
		const inputTempPath = tempfile()
		const outputTempPath = tempfile()
		
		try {
			// Load original file from blob to temp file
			await loadFileFromBlob(file.originalStorageKey, inputTempPath)
			
			// Perform conversion
			await conversionFunction(inputTempPath, { ...config, dest: outputTempPath })
			
			// Save processed file back to blob storage
			await saveProcessedFileToBlob(outputTempPath, file.storageKey)
			
			// Clean up temp files
			await fs.unlink(inputTempPath).catch(() => {})
			await fs.unlink(outputTempPath).catch(() => {})
			
			// Clean up original blob since we don't need it anymore
			await store.delete(file.originalStorageKey).catch(() => {})
			
		} catch (error) {
			// Clean up temp files on error
			await fs.unlink(inputTempPath).catch(() => {})
			await fs.unlink(outputTempPath).catch(() => {})
			throw error
		}
	}
}

app.post('/opencc-convert-epub', handleFileMiddleware('application/epub+zip'), (req, res) => {
	const { file } = req
	const task = processFileWithBlobs(file, openccCvtEpub, {
		type: {
			from: req.body['type-from'],
			to: req.body['type-to']
		}
	})
	handleTaskCompletion(file, task)
})
app.post('/opencc-convert-txt', handleFileMiddleware('text/plain'), (req, res) => {
	const { file } = req
	const task = processFileWithBlobs(file, openccCvtText, {
		type: {
			from: req.body['type-from'],
			to: req.body['type-to']
		}
	})
	handleTaskCompletion(file, task)
})
app.post('/zhc-convert-epub', handleFileMiddleware('application/epub+zip'), (req, res) => {
	const { file } = req
	const task = processFileWithBlobs(file, zhcCvtEpub, {
		type: req.body.type
	})
	handleTaskCompletion(file, task)
})
app.post('/zhc-convert-txt', handleFileMiddleware('text/plain'), (req, res) => {
	const { file } = req
	const task = processFileWithBlobs(file, zhcCvtText, {
		type: req.body.type
	})
	handleTaskCompletion(file, task)
})

const PORT = process.env.PORT || 8763

// Allow local development: only start server if run directly
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () =>
        console.log(`Server is listening at http://localhost:${PORT}`)
    );
}

module.exports = app
