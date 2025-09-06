// Popup script for YouTube AI Chatbot
class YouTubeChatbot {
    constructor() {
        this.currentVideo = null;
        this.messages = [];
        this.isLoading = false;
        this.apiEndpoint = ''; // TODO: Set your API endpoint here

        // Initialize with a small delay to ensure DOM is ready
        setTimeout(() => {
            this.initializeElements();
            this.setupEventListeners();
            this.loadCurrentVideo();
            this.loadChatHistory();
        }, 100);
    }

    initializeElements() {
        this.chatContainer = document.getElementById('chatContainer');
        this.messageInput = document.getElementById('messageInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.clearBtn = document.getElementById('clearChat');
        this.videoInfo = document.getElementById('videoInfo');
        this.videoTitle = document.getElementById('videoTitle');
        this.videoChannel = document.getElementById('videoChannel');
        this.charCount = document.getElementById('charCount');
        this.loadingOverlay = document.getElementById('loadingOverlay');
        this.apiStatus = document.getElementById('apiStatus');
        this.connectionStatus = document.getElementById('connectionStatus');
    }

    setupEventListeners() {
        // Send button click
        this.sendBtn.addEventListener('click', () => this.sendMessage());

        // Enter key press
        this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Input change
        this.messageInput.addEventListener('input', () => {
            this.updateCharCount();
            this.updateSendButton();
        });

        // Clear chat button
        this.clearBtn.addEventListener('click', () => this.clearChat());

        // Listen for video changes
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            try {
                if (message.type === 'VIDEO_CHANGED') {
                    this.updateVideoInfo(message.videoInfo);
                    sendResponse({ received: true });
                }
            } catch (error) {
                console.error('Error handling runtime message:', error);
                sendResponse({ error: error.message });
            }
            return true; // Keep the message channel open
        });
    }

    updateCharCount() {
        const count = this.messageInput.value.length;
        this.charCount.textContent = count;
        
        if (count > 450) {
            this.charCount.style.color = '#dc3545';
        } else if (count > 350) {
            this.charCount.style.color = '#ffc107';
        } else {
            this.charCount.style.color = '#6c757d';
        }
    }

    updateSendButton() {
        const hasText = this.messageInput.value.trim().length > 0;
        this.sendBtn.disabled = !hasText || this.isLoading;
    }

    async loadCurrentVideo() {
        try {
            // Get current tab
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            if (tab && tab.url && tab.url.includes('youtube.com/watch')) {
                // Send message to content script with error handling
                chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_VIDEO' }, (response) => {
                    // Check for chrome.runtime.lastError
                    if (chrome.runtime.lastError) {
                        console.log('Content script not ready, trying to inject...');
                        this.injectAndRetry(tab.id);
                        return;
                    }
                    
                    if (response && response.videoId) {
                        this.updateVideoInfo(response);
                    } else {
                        this.showNoVideoMessage();
                    }
                });
            } else {
                this.showNoVideoMessage();
            }
        } catch (error) {
            console.error('Error loading current video:', error);
            this.showNoVideoMessage();
        }
    }

    async injectAndRetry(tabId) {
        try {
            // Inject content script manually
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            });
            
            // Wait a bit for the script to initialize
            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { type: 'GET_CURRENT_VIDEO' }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.log('Still unable to connect to content script');
                        this.showNoVideoMessage();
                        return;
                    }
                    
                    if (response && response.videoId) {
                        this.updateVideoInfo(response);
                    } else {
                        this.showNoVideoMessage();
                    }
                });
            }, 1000);
        } catch (error) {
            console.error('Error injecting content script:', error);
            this.showNoVideoMessage();
        }
    }

    updateVideoInfo(videoInfo) {
        if (videoInfo && videoInfo.videoId) {
            this.currentVideo = videoInfo;
            this.videoTitle.textContent = videoInfo.title || 'Unknown Title';
            this.videoChannel.textContent = videoInfo.channel || 'Unknown Channel';
            this.videoInfo.style.display = 'block';
            this.connectionStatus.textContent = 'Connected to video';
            
            // Update placeholder
            this.messageInput.placeholder = `Ask about "${videoInfo.title}"...`;
            
            // Enable input
            this.messageInput.disabled = false;
        } else {
            this.showNoVideoMessage();
        }
    }

    showNoVideoMessage() {
        this.videoInfo.style.display = 'none';
        this.connectionStatus.textContent = 'No YouTube video detected';
        this.messageInput.placeholder = 'Please open a YouTube video first...';
        this.messageInput.disabled = true;
        this.sendBtn.disabled = true;
        
        // Try to extract video info from current URL as fallback
        this.tryExtractFromUrl();
    }

    async tryExtractFromUrl() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.url && tab.url.includes('youtube.com/watch')) {
                const url = new URL(tab.url);
                const videoId = url.searchParams.get('v');
                
                if (videoId) {
                    const fallbackInfo = {
                        videoId: videoId,
                        url: tab.url,
                        title: tab.title || 'YouTube Video',
                        channel: 'Unknown Channel',
                        description: ''
                    };
                    
                    this.updateVideoInfo(fallbackInfo);
                    this.connectionStatus.textContent = 'Connected (fallback mode)';
                }
            }
        } catch (error) {
            console.log('Fallback URL extraction failed:', error);
        }
    }

    async sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message || this.isLoading) return;

        // Add user message to chat
        this.addMessage(message, 'user');
        this.messageInput.value = '';
        this.updateCharCount();
        this.updateSendButton();

        // Show loading
        this.setLoading(true);

        try {
            // Get AI response
            const response = await this.getAIResponse(message);
            this.addMessage(response, 'bot');
        } catch (error) {
            console.error('Error getting AI response:', error);
            this.addMessage(
                'Sorry, I encountered an error while processing your request. Please try again.',
                'bot',
                'error'
            );
        } finally {
            this.setLoading(false);
        }

        // Save chat history
        this.saveChatHistory();
    }

    async getAIResponse(userMessage) {
        try {
            // First check if RAG API is available
            const healthCheck = await this.checkAPIHealth();
            if (!healthCheck.success) {
                return `RAG API is not available: ${healthCheck.error}\n\nPlease make sure the RAG API server is running by executing:\npython3 main.py\n\nThen refresh this extension.`;
            }

            // Format conversation history for RAG API
            const conversationHistory = this.messages.slice(-10).map(msg => ({
                text: msg.text,
                sender: msg.sender,
                timestamp: msg.timestamp || Date.now()
            }));

            // Prepare data for background script
            const requestData = {
                message: userMessage,
                conversationHistory: conversationHistory
            };

            // Send request through background script
            const response = await chrome.runtime.sendMessage({
                type: 'CHAT_REQUEST',
                data: requestData
            });

            if (response.success) {
                let botResponse = response.response;
                
                // Add metadata information if available
                if (response.metadata) {
                    const confidence = response.confidence || response.metadata.confidence;
                    const processingTime = response.processingTime || response.metadata.processing_time;
                    
                    if (confidence !== undefined && confidence < 0.7) {
                        botResponse += `\n\n*Note: This response has moderate confidence (${Math.round(confidence * 100)}%). The video transcript might not contain detailed information about your question.*`;
                    }
                }
                
                return botResponse;
            } else {
                throw new Error(response.error || 'Unknown error occurred');
            }
        } catch (error) {
            console.error('Error getting AI response:', error);
            
            // Check if it's a connection error
            if (error.message.includes('Extension context invalidated')) {
                return 'The extension needs to be reloaded. Please refresh the page and try again.';
            }
            
            return this.getMockResponse(userMessage);
        }
    }

    async checkAPIHealth() {
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'CHECK_API_HEALTH'
            });
            return response;
        } catch (error) {
            return {
                success: false,
                error: 'Could not check API health. Extension might need to be reloaded.'
            };
        }
    }

    getMockResponse(userMessage) {
        const responses = [
            "I'd be happy to help you analyze this video! However, the RAG API server is currently not running.\n\nTo get AI-powered responses:\n1. Open a terminal in the extension folder\n2. Run: python3 main.py\n3. Refresh this extension\n\nThe API will then analyze YouTube transcripts and answer your questions using Google Gemini AI.",
            "That's an interesting question about this video! To get detailed analysis based on the video's transcript, please start the RAG API server:\n\n1. Navigate to the extension directory\n2. Run: python3 main.py\n3. Make sure you have set your GOOGLE_API_KEY\n4. Refresh the extension\n\nThen I'll be able to provide detailed answers about the video content.",
            "I can see you're asking about the video content. The extension is ready to use RAG (Retrieval-Augmented Generation) to analyze YouTube transcripts, but the API server needs to be started first.\n\nPlease run 'python3 main.py' in the extension folder and refresh this page.",
            "Great question! This extension uses a local RAG API to analyze YouTube video transcripts with Google Gemini AI. To enable this functionality:\n\n• Start the API server: python3 main.py\n• Set your GOOGLE_API_KEY environment variable\n• Refresh this extension\n\nThen I'll provide intelligent responses based on the video's actual content!"
        ];

        // Add some delay to simulate API call
        return new Promise(resolve => {
            setTimeout(() => {
                const randomResponse = responses[Math.floor(Math.random() * responses.length)];
                resolve(randomResponse);
            }, 1000 + Math.random() * 2000);
        });
    }

    addMessage(text, sender, type = 'normal') {
        const messageDiv = document.createElement('div');
        messageDiv.className = `${sender}-message`;

        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        messageDiv.innerHTML = `
            <div class="message-avatar">${sender === 'user' ? '👤' : '🤖'}</div>
            <div class="message-content">
                <div class="message-text ${type}">${this.escapeHtml(text)}</div>
                <div class="message-time">${time}</div>
            </div>
        `;

        // Remove welcome message if it exists
        const welcomeMessage = this.chatContainer.querySelector('.welcome-message');
        if (welcomeMessage && this.messages.length === 0) {
            welcomeMessage.remove();
        }

        this.chatContainer.appendChild(messageDiv);
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;

        // Store message
        this.messages.push({
            text,
            sender,
            timestamp: Date.now(),
            type
        });
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    setLoading(loading) {
        this.isLoading = loading;
        this.loadingOverlay.style.display = loading ? 'flex' : 'none';
        this.updateSendButton();
        
        if (loading) {
            this.messageInput.disabled = true;
        } else {
            this.messageInput.disabled = !this.currentVideo;
        }
    }

    clearChat() {
        // Remove all messages except welcome
        const messages = this.chatContainer.querySelectorAll('.user-message, .bot-message:not(.welcome-message .bot-message)');
        messages.forEach(msg => msg.remove());
        
        // Reset messages array
        this.messages = [];
        
        // Clear storage
        chrome.storage.local.remove('chatHistory');
        
        // Add welcome message back if it doesn't exist
        if (!this.chatContainer.querySelector('.welcome-message')) {
            this.addWelcomeMessage();
        }
    }

    addWelcomeMessage() {
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'welcome-message';
        welcomeDiv.innerHTML = `
            <div class="bot-message">
                <div class="message-avatar">🤖</div>
                <div class="message-content">
                    <div class="message-text">
                        Hi! I'm your YouTube AI assistant. I can help you with questions about the video you're watching. What would you like to know?
                    </div>
                    <div class="message-time">Now</div>
                </div>
            </div>
        `;
        this.chatContainer.insertBefore(welcomeDiv, this.chatContainer.firstChild);
    }

    saveChatHistory() {
        if (this.currentVideo) {
            const historyKey = `chat_${this.currentVideo.videoId}`;
            chrome.storage.local.set({
                [historyKey]: {
                    messages: this.messages,
                    videoInfo: this.currentVideo,
                    lastUpdated: Date.now()
                }
            });
        }
    }

    async loadChatHistory() {
        if (this.currentVideo) {
            const historyKey = `chat_${this.currentVideo.videoId}`;
            const result = await chrome.storage.local.get(historyKey);
            
            if (result[historyKey] && result[historyKey].messages) {
                const history = result[historyKey];
                
                // Load messages if they're recent (within 24 hours)
                const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
                if (history.lastUpdated > dayAgo) {
                    // Remove welcome message
                    const welcomeMessage = this.chatContainer.querySelector('.welcome-message');
                    if (welcomeMessage) {
                        welcomeMessage.remove();
                    }
                    
                    // Add stored messages
                    history.messages.forEach(msg => {
                        this.addMessage(msg.text, msg.sender, msg.type);
                    });
                }
            }
        }
    }

    // Public method to update API endpoint
    setApiEndpoint(endpoint) {
        this.apiEndpoint = endpoint;
        this.updateApiStatus();
    }

    updateApiStatus() {
        const statusDot = this.apiStatus.querySelector('.status-dot');
        const statusText = this.apiStatus.querySelector('span:last-child');
        
        if (this.apiEndpoint) {
            statusDot.className = 'status-dot';
            statusText.textContent = 'API Connected';
        } else {
            statusDot.className = 'status-dot warning';
            statusText.textContent = 'API Not Configured';
        }
    }
}

// Initialize chatbot when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.chatbot = new YouTubeChatbot();
    
    // You can set the API endpoint here:
    // window.chatbot.setApiEndpoint('https://your-api-endpoint.com/chat');
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = YouTubeChatbot;
}