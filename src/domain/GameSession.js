const Participant = require('./Participant');

// Added a few more words for better random selection
const WORD_LIST = ["elephant", "guitar", "astronaut", "pizza", "mountain", "robot", "ocean", "bicycle", "castle", "dragon", "vampire", "telephone", "satellite", "pyramid"];

class GameSession {
    constructor(sessionId, adminId, config, io) {
        this.sessionId = sessionId;
        this.adminId = adminId;
        this.io = io; 
        this.activeParticipants = new Map(); 
        
        this.sessionConfig = {
            maxCapacity: config.maxPlayers || 8,
            totalRounds: config.rounds || 3,
            drawDuration: config.drawTime || 80, 
        };

        this.matchState = {
            currentPhase: 'Lobby', 
            roundNumber: 0,
            activeDrawerId: null,
            targetWord: '',
            canvasLogs: [], 
            timer: 0
        };
        
        this.timerInterval = null;
        this.drawnPlayers = []; // New array: tracks which players have drawn in the current round
    }

    joinSession(socketId, displayName) {
        if (this.activeParticipants.size >= this.sessionConfig.maxCapacity) {
            throw new Error('Session has reached maximum capacity');
        }
        const newParticipant = new Participant(socketId, displayName);
        this.activeParticipants.set(socketId, newParticipant);
        return newParticipant;
    }

    // --- PHASE 2: CORE GAME LOOP LOGIC ---

    startGame() {
        this.matchState.roundNumber = 1;
        this.drawnPlayers = [];
        this.startNextTurn();
    }

    // Helper: get 3 random unique words
    getRandomWords(count) {
        const shuffled = [...WORD_LIST].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, count);
    }

    startNextTurn() {
        clearInterval(this.timerInterval);

        // Check 1: Have all players drawn in this round?
        if (this.drawnPlayers.length >= this.activeParticipants.size) {
            this.matchState.roundNumber++; // start a new round
            this.drawnPlayers = []; // clear list for the new round
        }

        // Check 2: Have all rounds finished? (GAME OVER CHECK)
        if (this.matchState.roundNumber > this.sessionConfig.totalRounds) {
            return this.endGame();
        }

        const playersArray = Array.from(this.activeParticipants.values());
        playersArray.forEach(p => {
            p.resetTurnState();
            p.isCurrentlyDrawing = false;
        });

        // Find a player who hasn't drawn yet in this round
        const availableDrawers = playersArray.filter(p => !this.drawnPlayers.includes(p.connectionId));
        const nextDrawer = availableDrawers[Math.floor(Math.random() * availableDrawers.length)];
        
        nextDrawer.isCurrentlyDrawing = true;
        this.drawnPlayers.push(nextDrawer.connectionId);
        this.matchState.activeDrawerId = nextDrawer.connectionId;

        // Phase change to WordSelection
        this.matchState.currentPhase = 'WordSelection';
        this.matchState.targetWord = ''; 
        this.matchState.canvasLogs = []; 
        this.matchState.timer = 15; // Drawer gets 15 seconds to choose a word

        const wordChoices = this.getRandomWords(3);

        // Broadcast to EVERYONE that word selection is happening
        this.io.to(this.sessionId).emit('round_start', {
            drawerId: this.matchState.activeDrawerId,
            phase: 'WordSelection',
            round: this.matchState.roundNumber,
            totalRounds: this.sessionConfig.totalRounds
        });

        // Privately send 3 word choices to the Drawer
        this.io.to(this.matchState.activeDrawerId).emit('word_choices', { words: wordChoices });

        // Timer for word selection
        this.timerInterval = setInterval(() => {
            this.matchState.timer--;
            this.io.to(this.sessionId).emit('timer_tick', { timeLeft: this.matchState.timer });

            if (this.matchState.timer <= 0) {
                // If drawer didn't choose in time, auto-pick the first word
                this.selectWord(this.matchState.activeDrawerId, wordChoices[0]);
            }
        }, 1000);
    }

    // New function: called when the drawer selects a word from the UI
    selectWord(socketId, word) {
        if (socketId !== this.matchState.activeDrawerId || this.matchState.currentPhase !== 'WordSelection') return;

        clearInterval(this.timerInterval); // Stop selection timer
        
        this.matchState.targetWord = word;
        this.matchState.currentPhase = 'ActiveDrawing';
        this.matchState.timer = this.sessionConfig.drawDuration;

        // Tell everyone drawing started & word length
        this.io.to(this.sessionId).emit('word_chosen', {
            wordLength: word.length,
            drawTime: this.sessionConfig.drawDuration,
            drawerId: this.matchState.activeDrawerId
        });

        // Privately tell the drawer their chosen word
        this.io.to(this.matchState.activeDrawerId).emit('your_word', { word: word });

        this.startDrawTimer(); // Start the actual drawing timer
    }

    startDrawTimer() {
        clearInterval(this.timerInterval);
        this.timerInterval = setInterval(() => {
            this.matchState.timer--;
            this.io.to(this.sessionId).emit('timer_tick', { timeLeft: this.matchState.timer });

            if (this.matchState.timer <= 0) {
                this.endTurn();
            }
        }, 1000);
    }

    endTurn() {
        clearInterval(this.timerInterval);
        this.matchState.currentPhase = 'RoundReveal';
        
        this.io.to(this.sessionId).emit('round_end', {
            word: this.matchState.targetWord,
            scores: Array.from(this.activeParticipants.values()).map(p => ({ id: p.connectionId, score: p.totalPoints }))
        });

        setTimeout(() => this.startNextTurn(), 5000); // 5 seconds wait before next drawer
    }

    endGame() {
        clearInterval(this.timerInterval);
        this.matchState.currentPhase = 'GameOver';

        // Sort players by score for Leaderboard
        const leaderboard = Array.from(this.activeParticipants.values())
            .map(p => ({ id: p.connectionId, name: p.displayName, score: p.totalPoints }))
            .sort((a, b) => b.score - a.score);

        this.io.to(this.sessionId).emit('game_over', {
            leaderboard: leaderboard,
            winner: leaderboard[0] // Highest scorer
        });
    }

    processGuess(socketId, guessText) {
        if (this.matchState.currentPhase !== 'ActiveDrawing') return false;
        if (socketId === this.matchState.activeDrawerId) return false; 

        const participant = this.activeParticipants.get(socketId);
        if (participant.hasCorrectlyGuessed) return false; 

        if (guessText.toLowerCase() === this.matchState.targetWord.toLowerCase()) {
            participant.hasCorrectlyGuessed = true;
            
            const timeMultiplier = this.matchState.timer / this.sessionConfig.drawDuration;
            const pointsEarned = Math.floor(timeMultiplier * 500) + 100; 
            
            participant.awardPoints(pointsEarned);
            
            this.io.to(this.sessionId).emit('guess_result', {
                correct: true,
                playerId: socketId,
                playerName: participant.displayName,
                points: pointsEarned
            });
            return true; 
        }
        return false; 
    }

    saveCanvasStroke(strokeData) {
        this.matchState.canvasLogs.push(strokeData);
    }
    
    clearCanvas() {
        this.matchState.canvasLogs = [];
    }

    getParticipantRoster() {
        return Array.from(this.activeParticipants.values());
    }

    leaveSession(socketId) {
        this.activeParticipants.delete(socketId);
    }
} 

module.exports = GameSession;