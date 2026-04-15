# Privacy Policy — Smart Bookmark

**Last updated: April 15, 2026**

## Overview

Smart Bookmark is a Chrome extension that provides AI-powered semantic and keyword search over your bookmarks. This policy explains what data the extension accesses and how it is handled.

## Data Collected and How It Is Used

### Bookmark Data
The extension reads your Chrome bookmarks (titles and URLs) to build a local search index. This data never leaves your device.

### Webpage Content
To generate semantic search embeddings, the extension temporarily fetches the content of your bookmarked URLs. The raw page content is **not stored**. Only a numerical vector embedding (384 numbers representing the semantic meaning of the page) is stored locally in your browser's IndexedDB database.

### AI Model Weights
On first use, the extension downloads a pre-trained AI model (~25 MB) from **Hugging Face** (`huggingface.co`) to enable semantic search. This is a one-time download of model weights — no user data is sent to Hugging Face.

### User Plan Information *(future feature)*
In a future version, the extension may allow account sign-in for premium features. If implemented, your email address and subscription status will be stored locally and transmitted only to our authentication server.

## Data Storage

All data (bookmark index, embeddings, settings) is stored **locally on your device** using Chrome's IndexedDB and `chrome.storage` APIs. Nothing is uploaded to any server.

## Data Sharing

We do not sell, share, or transmit your personal data to any third parties, with the sole exception of:
- The Hugging Face CDN, which serves the AI model file (no user data is included in this request)

## Data Retention and Deletion

All locally stored data can be deleted at any time by clicking **Rescan** (which wipes and rebuilds the index) or by uninstalling the extension (which removes all stored data).

## Permissions Justification

| Permission | Reason |
|---|---|
| `bookmarks` | Read your bookmarks to build the search index |
| `storage` | Store settings and user plan info locally |
| `unlimitedStorage` | Store AI embeddings for all bookmarks without hitting quota limits |
| `host_permissions: <all_urls>` | Fetch bookmark page content to generate semantic embeddings |

## Contact

If you have questions about this policy, contact: djordjevicm984@gmail.com
