const Participant = require('./Participant');

// Basic dictionary (Hum isko baad mein config file se replace kar sakte hain)
const WORD_LIST = ["elephant", "guitar", "astronaut", "pizza", "mountain", "robot"];

class GameSession {
    constructor(sessionId, adminId, config, io) {
        this.sessionId = sessionId;
        this.adminId = adminId;
        this.io = io; // Socket.IO instance for broadcasting to this room
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
            canvasLogs: [], // Saves the drawing state for late joiners
            timer: 0
        };
        
        this.timerInterval = null;
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
        // if (this.activeParticipants.size < 2) throw new Error("Need at least 2 players to start");
        this.matchState.roundNumber = 1;
        this.startNextTurn();
    }

    startNextTurn() {
        // Logic to pick the next drawer (simplified for now: pick random or first)
        const playersArray = Array.from(this.activeParticipants.values());
        
        // Reset guessing states
        playersArray.forEach(p => p.resetTurnState());

        const nextDrawer = playersArray[Math.floor(Math.random() * playersArray.length)];
        nextDrawer.isCurrentlyDrawing = true;

        this.matchState.activeDrawerId = nextDrawer.connectionId;
        this.matchState.targetWord = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
        this.matchState.currentPhase = 'ActiveDrawing';
        this.matchState.canvasLogs = []; // Clear canvas for new turn
        this.matchState.timer = this.sessionConfig.drawDuration;

        // Broadcast turn info to the room
        this.io.to(this.sessionId).emit('round_start', {
            drawerId: this.matchState.activeDrawerId,
            drawTime: this.sessionConfig.drawDuration,
            // HINT: Hum drawer ko real word bhejenge, baakiyo ko underscores bhejenge (Frontend pe handle karenge)
            wordLength: this.matchState.targetWord.length 
        });

        // Privately send the actual word to the drawer
        this.io.to(this.matchState.activeDrawerId).emit('word_chosen', { word: this.matchState.targetWord });

        this.startTimer();
    }

    startTimer() {
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
        
        // Send the actual word and updated scores to everyone
        this.io.to(this.sessionId).emit('round_end', {
            word: this.matchState.targetWord,
            scores: Array.from(this.activeParticipants.values()).map(p => ({ id: p.connectionId, score: p.totalPoints }))
        });

        // Wait 5 seconds before starting the next turn
        setTimeout(() => this.startNextTurn(), 5000);
    }

    processGuess(socketId, guessText) {
        if (this.matchState.currentPhase !== 'ActiveDrawing') return false;
        if (socketId === this.matchState.activeDrawerId) return false; // Drawer can't guess

        const participant = this.activeParticipants.get(socketId);
        if (participant.hasCorrectlyGuessed) return false; // Already guessed

        if (guessText.toLowerCase() === this.matchState.targetWord.toLowerCase()) {
            participant.hasCorrectlyGuessed = true;
            
            // Pro Scoring Algorithm: More time left = more points
            const timeMultiplier = this.matchState.timer / this.sessionConfig.drawDuration;
            const pointsEarned = Math.floor(timeMultiplier * 500) + 100; // Base 100 + up to 500 bonus
            
            participant.awardPoints(pointsEarned);
            
            this.io.to(this.sessionId).emit('guess_result', {
                correct: true,
                playerId: socketId,
                playerName: participant.displayName,
                points: pointsEarned
            });
            return true; // Secret guessed, don't broadcast chat
        }
        return false; // Wrong guess, broadcast as normal chat
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
} // End of GameSession class

module.exports = GameSession;