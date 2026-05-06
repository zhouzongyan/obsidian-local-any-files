import { requestUrl, RequestUrlResponse } from "obsidian";
import LocalAnyFilesPlugin from "src/main";
import { simpleHash } from "./link-extractor";

export interface DownloadResult {
	success: boolean;
	localPath: string;
	error?: string;
}

export class FileDownloader {
	private storePath: string;
	private variables: Record<string, string>;
	private storeFileName: string;
	private plugin: LocalAnyFilesPlugin;

	constructor(plugin: LocalAnyFilesPlugin, storePath: string, variables: Record<string, string>, storeFileName: string) {
		this.plugin = plugin;
		this.storePath = storePath;
		this.variables = variables;
		this.storeFileName = storeFileName || '${originalName}';
	}

	private getCleanFileName(url: string): string {
		try {
			// Parse the URL and get the pathname
			const urlObj = new URL(url);
			const pathname = urlObj.pathname;
			
			// Get the filename from the last segment of the path
			let filename = pathname.split('/').pop() || '';
			
			// Remove query parameters if present in the filename
			filename = filename.split('?')[0];
			
			// If no filename found, use a hash of the full URL
			if (!filename) {
				filename = simpleHash(url);
			}
			
			return filename;
		} catch (error) {
			// If URL parsing fails, use a hash of the URL
			return simpleHash(url);
		}
	}

	private getExtension(fileName: string): string {
		const lastDotIndex = fileName.lastIndexOf('.');
		if (lastDotIndex === -1) return '';
		return fileName.slice(lastDotIndex).toLowerCase();
	}

	private getExtensionFromContentType(contentType: string): string {
		const mimeToExt: { [key: string]: string } = {
			'image/jpeg': '.jpeg',
			'image/jpg': '.jpg',
			'image/png': '.png',
			'image/gif': '.gif',
			'image/webp': '.webp',
			'image/svg+xml': '.svg',
			'image/bmp': '.bmp',
			'image/tiff': '.tiff',
			'image/vnd.adobe.photoshop': '.psd',
			'image/vnd.microsoft.icon': '.ico',
			'application/pdf': '.pdf',
			'video/mp4': '.mp4',
			'video/webm': '.webm',
			'audio/mpeg': '.mp3',
			'audio/wav': '.wav',
			'audio/webm': '.weba',
			'application/json': '.json',
			'text/json': '.json',
			'text/plain': '.txt',
			'text/html': '.html',
			'text/css': '.css',
			'text/javascript': '.js',
			'application/javascript': '.js',
			'application/xml': '.xml',
			'text/xml': '.xml',
			'application/zip': '.zip',
			'application/x-rar-compressed': '.rar',
			'application/x-7z-compressed': '.7z',
			'application/x-tar': '.tar',
			'application/x-gzip': '.gz',
			'application/x-bzip2': '.bz2',
			'application/x-xz': '.xz',
			'application/x-iso9660-image': '.iso',
			'application/x-gzip-compressed': '.tgz',
			'application/x-compressed': '.z',
			'application/x-bzip2-compressed': '.bzip2',
			'application/x-cab-compressed': '.cab'
		};

		// Get the base MIME type without parameters
		const baseMimeType = contentType.split(';')[0].trim().toLowerCase();
		return mimeToExt[baseMimeType] || '.unknown';
	}

	private async getLocalPath(originalUrl: string, fileName: string, extension: string): Promise<string> {
		let path = this.storePath;
		const cleanFileName = this.getCleanFileName(originalUrl);

		// Set extension variable
		this.variables.extension = extension.substring(1);

		// Replace variables in path
		Object.entries(this.variables).forEach(([key, value]) => {
			path = path.split(`\${${key}}`).join(this.sanitizePath(value));
		});

		// Generate the filename using the pattern
		let generatedFileName = this.storeFileName;
		const fileVariables = {
			...this.variables,
			originalName: cleanFileName,
			random: simpleHash(originalUrl)
		};

		Object.entries(fileVariables).forEach(([key, value]) => {
			generatedFileName = generatedFileName.split(`\${${key}}`).join(this.sanitizePath(value));
		});

		// Ensure the filename has the correct extension
		if (!generatedFileName.endsWith(extension)) {
			generatedFileName += extension;
		}

		// Sanitize the final path
		path = this.normalizeVaultPath(this.sanitizePath(path));
		generatedFileName = this.sanitizePath(generatedFileName);

		return this.normalizeVaultPath(`${path}/${generatedFileName}`);
	}

	async downloadFile(url: string, fileName: string, isMarkdownImage = false): Promise<DownloadResult> {
		try {
			const response = await requestUrl({
				url,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
				},
				throw: false,
				method: 'GET'
			});

			if (response.status !== 200) {
				return {
					success: false,
					error: `Failed to download file: ${response.status} ${response.text}`,
					localPath: ''
				};
			}

			let extension = this.getExtension(fileName);
			
			// If no extension found or it's unknown, try to get it from content-type
			if (!extension || extension === '.unknown') {
				const contentType = response.headers['content-type'];
				if (contentType) {
					extension = this.getExtensionFromContentType(contentType);
				}
			}

			const localPath = await this.getLocalPath(url, fileName, extension);

			// Ensure the directory exists before saving
			const dirPath = localPath.substring(0, localPath.lastIndexOf('/'));
			if (dirPath) {
				await this.plugin.app.vault.adapter.mkdir(dirPath);
			}

			// Save the file
			await this.saveFile(response, localPath);

			return {
				success: true,
				error: '',
				localPath: localPath
			};
		} catch (error) {
			return {
				success: false,
				error: `Error downloading file: ${error}`,
				localPath: ''
			};
		}
	}

	private sanitizePath(path: string): string {
		// Replace spaces and other common illegal characters with underscores
		return path.replace(/[\s<>:"\\|?*]/g, '_');
	}

	private normalizeVaultPath(path: string): string {
		return path
			.replace(/\/+/g, '/')
			.replace(/^\/+/, '')
			.replace(/\/+$/, '');
	}

	private async saveFile(response: RequestUrlResponse, path: string): Promise<void> {
		if (!this.plugin?.app?.vault?.adapter) {
			throw new Error('App vault adapter not found');
		}

		// Use arrayBuffer directly if available
		if (response.arrayBuffer) {
			await this.plugin.app.vault.adapter.writeBinary(path, response.arrayBuffer);
			return;
		}

		// If we have binary data in text format, convert it
		if (response.text && response.headers['content-type']?.includes('application/octet-stream')) {
			const byteCharacters = atob(response.text);
			const byteNumbers = new Array(byteCharacters.length);
			for (let i = 0; i < byteCharacters.length; i++) {
				byteNumbers[i] = byteCharacters.charCodeAt(i);
			}
			const byteArray = new Uint8Array(byteNumbers);
			await this.plugin.app.vault.adapter.writeBinary(path, byteArray.buffer);
			return;
		}

		// Last resort: convert text to ArrayBuffer
		if (response.text) {
			const encoder = new TextEncoder();
			const data = encoder.encode(response.text).buffer;
			await this.plugin.app.vault.adapter.writeBinary(path, data);
			return;
		}

		throw new Error('No valid data found in response');
	}
}
