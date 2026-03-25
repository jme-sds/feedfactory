from sqlmodel import SQLModel, Field, Relationship
from typing import Optional, List
import datetime

class GlobalSettings(SQLModel, table=True):
    id: int = Field(default=1, primary_key=True)
    api_type: str = Field(default="openai") 
    api_endpoint: str = Field(default="https://router.huggingface.co/v1/chat/completions") 
    api_key: Optional[str] = None 
    model_name: str = Field(default="Qwen/Qwen2.5-72B-Instruct") 
    default_schedule: str = Field(default="06:00")
    default_context_length: int = Field(default=200)
    default_filter_max: int = Field(default=0)
    default_filter_age: str = Field(default="24h")
    default_system_prompt: str = Field(default="You are an expert news editor...")

class Collection(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    slug: str = Field(unique=True, index=True)
    schedule_time: str = Field(default="06:00")
    last_run: Optional[datetime.datetime] = None
    is_generating: bool = Field(default=False)
    system_prompt: Optional[str] = Field(default=None)
    context_length: int = Field(default=200) 
    filter_max_articles: int = Field(default=0) 
    filter_age: str = Field(default="24h") 
    feeds: List["Feed"] = Relationship(back_populates="collection")

class Feed(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    url: str
    collection_id: Optional[int] = Field(default=None, foreign_key="collection.id")
    collection: Optional[Collection] = Relationship(back_populates="feeds")

# --- NEW: External Subscriptions for the Reader ---
class Subscription(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    url: str = Field(unique=True)
    title: Optional[str] = None
    added_at: datetime.datetime = Field(default_factory=datetime.datetime.now)
